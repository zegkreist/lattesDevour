import fs from 'node:fs';
import { chromium, type BrowserContext, type Download, type Page } from 'playwright';
import { config, paths } from '../config.js';
import { getSetting, pool } from '../db.js';
import { extractXml } from '../util/xmlfile.js';
import { saveXml } from './pipeline.js';
import { chave2Captcha, Erro2Captcha, resolverRecaptcha } from './twocaptcha.js';

// O Lattes protege a busca e o download do XML com reCAPTCHA v2. Com chave do 2Captcha
// (aba Coleta ou TWOCAPTCHA_API_KEY) o coletor manda o captcha para o 2Captcha, injeta o token e confirma o download; se o
// token não destravar o download, cai para o modo humano. Sem chave, abre o currículo num
// Chromium visível (Xvfb + noVNC), marca 'aguardando_captcha' e espera uma pessoa resolver.
// Em qualquer modo o ritmo é de 60 a 180 CVs por hora, espaçados, para não pesar no CNPq.
// Para volume, o caminho continua sendo o Extrator Lattes: zip/XML em data/import.

export interface CollectorState {
  rodando: boolean;
  atual: string | null;
  fase: 'ocioso' | 'abrindo' | 'resolvendo_captcha' | 'aguardando_captcha' | 'baixando' | 'pausado';
  mensagem: string;
  desde: string | null;
  baixadosNaSessao: number;
  novncUrl: string;
}

export const state: CollectorState = {
  rodando: false,
  atual: null,
  fase: 'ocioso',
  mensagem: 'parado',
  desde: null,
  baixadosNaSessao: 0,
  novncUrl: config.novncUrl,
};

export const POR_HORA = { min: 60, max: 180, padrao: 60 };

export async function cvsPorHora(): Promise<number> {
  const v = Number(await getSetting<number>('coleta.cvs_por_hora', POR_HORA.padrao));
  return Math.min(Math.max(Math.round(v) || POR_HORA.padrao, POR_HORA.min), POR_HORA.max);
}

let ctx: BrowserContext | null = null;
let loopPromise: Promise<void> | null = null;
// Início de cada CV na última hora (janela deslizante do teto por hora).
const inicios: number[] = [];

function set(fase: CollectorState['fase'], mensagem: string, atual: string | null = state.atual) {
  state.fase = fase;
  state.mensagem = mensagem;
  state.atual = atual;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Espera em fatias para o "Parar" valer mesmo no meio de uma espera longa.
async function esperar(ms: number): Promise<void> {
  const fim = Date.now() + ms;
  while (state.rodando && Date.now() < fim) await sleep(Math.min(5000, fim - Date.now()));
}

const hhmm = (t: number) => new Date(t).toLocaleTimeString('pt-BR', { timeZone: config.tz, hour: '2-digit', minute: '2-digit' });

export function iniciar(): void {
  if (state.rodando) return;
  state.rodando = true;
  state.desde = new Date().toISOString();
  state.baixadosNaSessao = 0;
  set('ocioso', 'iniciando');
  loopPromise = loop().finally(async () => {
    state.rodando = false;
    if (state.fase !== 'pausado') set('ocioso', 'parado', null);
    await ctx?.close().catch(() => {});
    ctx = null;
  });
}

export function parar(): void {
  state.rodando = false;
}

async function contexto(): Promise<BrowserContext> {
  if (ctx) return ctx;
  fs.mkdirSync(paths.browserProfile(), { recursive: true });
  ctx = await chromium.launchPersistentContext(paths.browserProfile(), {
    headless: config.headless,
    acceptDownloads: true,
    viewport: null,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--start-maximized'],
  });
  return ctx;
}

async function proximo(): Promise<{ lattes_id: string } | null> {
  const r = await pool.query(
    `UPDATE fila SET status='baixando', tentativas=tentativas+1, atualizado_em=now()
     WHERE lattes_id = (SELECT lattes_id FROM fila WHERE status='pendente' ORDER BY criado_em, lattes_id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING lattes_id`,
  );
  return r.rows[0] ?? null;
}

async function loop(): Promise<void> {
  while (state.rodando) {
    const maxPorHora = await cvsPorHora();
    while (inicios.length && inicios[0] < Date.now() - 3600_000) inicios.shift();
    if (inicios.length >= maxPorHora) {
      const volta = inicios[0] + 3600_000;
      set('ocioso', `teto de ${maxPorHora} CVs/hora atingido: retoma às ${hhmm(volta)}`, null);
      await esperar(volta - Date.now());
      continue;
    }
    const job = await proximo();
    if (!job) {
      set('ocioso', 'fila vazia: aguardando novos IDs', null);
      await sleep(5000);
      continue;
    }
    const id = job.lattes_id;
    const inicio = Date.now();
    inicios.push(inicio);
    try {
      const r = await baixar(id);
      if (r === 'timeout') {
        // Ninguém resolveu o captcha: devolve à fila e PAUSA, em vez de queimar a fila inteira.
        await pool.query(`UPDATE fila SET status='pendente', tentativas=GREATEST(tentativas-1,0), atualizado_em=now() WHERE lattes_id=$1`, [id]);
        state.rodando = false;
        set('pausado', `captcha de ${id} sem resposta em ${config.captchaTimeoutMs >= 60_000 ? Math.round(config.captchaTimeoutMs / 60_000) + ' min' : Math.round(config.captchaTimeoutMs / 1000) + ' s'}: coleta pausada`, null);
        break;
      }
    } catch (e) {
      if (e instanceof Erro2Captcha && e.fatal) {
        // Chave inválida, sem saldo, IP bloqueado: não adianta seguir para o próximo CV.
        await pool.query(`UPDATE fila SET status='pendente', tentativas=GREATEST(tentativas-1,0), atualizado_em=now() WHERE lattes_id=$1`, [id]);
        state.rodando = false;
        set('pausado', `${e.message}: coleta pausada`, null);
        break;
      }
      const erro = e instanceof Error ? e.message : String(e);
      await pool.query(
        `UPDATE fila SET status = CASE WHEN tentativas >= 3 THEN 'erro' ELSE 'pendente' END, ultimo_erro=$2, atualizado_em=now() WHERE lattes_id=$1`,
        [id, erro.slice(0, 500)],
      );
    }
    // Um CV a cada 3600/N s (±20%), de início a início; se o CV demorou mais que isso,
    // ainda respira 5 s. O teto por hora acima é só a trava.
    const intervalo = 3600_000 / maxPorHora;
    await esperar(Math.max(5000, inicio + intervalo * (0.8 + Math.random() * 0.4) - Date.now()));
  }
}

async function temCaptcha(page: Page): Promise<boolean> {
  return (await page.locator('iframe[src*="recaptcha"], .g-recaptcha, #divCaptcha').count()) > 0;
}

async function baixar(id: string): Promise<'ok' | 'sem_cv' | 'timeout'> {
  const c = await contexto();
  const page = c.pages()[0] ?? (await c.newPage());
  set('abrindo', `abrindo ${id}`, id);
  await page.goto(config.lattesDownloadUrl.replace('{id}', id), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(1500);

  if (await temCaptcha(page)) {
    const { chave } = await chave2Captcha();
    if (chave) {
      const dl = await resolverAuto(page, id, chave);
      if (dl) return await salvar(id, dl);
      // Sem sitekey ou o token não destravou o download: deixa para uma pessoa.
    }
    await pool.query(`UPDATE fila SET status='aguardando_captcha', atualizado_em=now() WHERE lattes_id=$1`, [id]);
    set('aguardando_captcha', `resolva o captcha de ${id} no navegador (noVNC) e confirme`, id);
    const dl = await page.waitForEvent('download', { timeout: config.captchaTimeoutMs }).catch(() => null);
    if (!dl) return 'timeout';
    return await salvar(id, dl);
  }
  // Sem captcha na página: ou o download dispara sozinho, ou o CV não existe / o fluxo mudou.
  const dl = await page.waitForEvent('download', { timeout: 15_000 }).catch(() => null);
  if (!dl) {
    await pool.query(
      `UPDATE fila SET status='sem_cv', ultimo_erro='sem captcha e sem download (CV inexistente ou fluxo do site mudou)', atualizado_em=now() WHERE lattes_id=$1`,
      [id],
    );
    return 'sem_cv';
  }
  return await salvar(id, dl);
}

async function resolverAuto(page: Page, id: string, chave: string): Promise<Download | null> {
  const sitekey = await page.evaluate(() => {
    const d = (globalThis as any).document;
    const el = d.querySelector('[data-sitekey]');
    if (el) return el.getAttribute('data-sitekey') as string;
    const f = d.querySelector('iframe[src*="recaptcha"]');
    return f ? new URL(f.src).searchParams.get('k') : null;
  });
  if (!sitekey) return null;
  set('resolvendo_captcha', `resolvendo o captcha de ${id} via 2Captcha`, id);
  const token = await resolverRecaptcha(chave, sitekey, page.url());

  const download = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null);
  await page.evaluate((token) => {
    const g = globalThis as any;
    for (const t of g.document.querySelectorAll('textarea[name="g-recaptcha-response"]')) t.value = token;
    // Callback declarado no HTML (data-callback) ou registrado via grecaptcha.render.
    const cbs: Function[] = [];
    const nome = g.document.querySelector('[data-callback]')?.getAttribute('data-callback');
    if (nome && typeof g[nome] === 'function') cbs.push(g[nome]);
    const achar = (o: any, n: number) => {
      if (!o || typeof o !== 'object' || n > 4) return;
      for (const [k, v] of Object.entries(o)) {
        if (k === 'callback' && typeof v === 'function') cbs.push(v as Function);
        else achar(v, n + 1);
      }
    };
    for (const c of Object.values(g.___grecaptcha_cfg?.clients ?? {})) achar(c, 0);
    for (const cb of new Set(cbs)) cb(token);
  }, token);
  // Se o callback já disparou o download, não clica de novo.
  const cedo = await Promise.race([download, sleep(3000).then(() => undefined)]);
  if (cedo !== undefined) return cedo;
  const botao = config.lattesSubmitSelector
    ? page.locator(config.lattesSubmitSelector)
    : page.getByRole('button', { name: /baixar|download|confirmar|enviar/i }).or(page.locator('input[type=submit], button[type=submit]'));
  await botao.first().click({ timeout: 10_000 }).catch(() => {});
  return await download;
}

async function salvar(id: string, dl: Download): Promise<'ok'> {
  set('baixando', `salvando ${id}`, id);
  const p = await dl.path();
  const bytes = extractXml(fs.readFileSync(p));
  if (!Buffer.from(bytes.subarray(0, 4096)).toString('latin1').includes('CURRICULO-VITAE')) {
    throw new Error('download não é um XML de currículo');
  }
  await saveXml(id, bytes, 'manual');
  state.baixadosNaSessao++;
  return 'ok';
}

export async function aguardarFim(): Promise<void> {
  await loopPromise;
}
