import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { config, paths } from '../config.js';
import { getSetting, pool } from '../db.js';
import { saveHtml } from './pipeline.js';
import { chave2Captcha, Erro2Captcha, resolverRecaptcha } from './twocaptcha.js';

// O Lattes protege a página do CV com reCAPTCHA v2. Com chave do 2Captcha (aba Coleta ou
// TWOCAPTCHA_API_KEY) o coletor manda o captcha para o 2Captcha, injeta o token e submete; se o
// token não abrir o CV, cai para o modo humano. Sem chave, abre o currículo num
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
        // Ninguém resolveu o captcha (ou clicaram em Parar): devolve à fila e PAUSA.
        await pool.query(`UPDATE fila SET status='pendente', tentativas=GREATEST(tentativas-1,0), atualizado_em=now() WHERE lattes_id=$1`, [id]);
        if (!state.rodando) break;
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
  return (await page.locator('#divCaptcha, iframe[src*="recaptcha"], .g-recaptcha').count()) > 0;
}

// A página do CV traz o próprio endereço "http://lattes.cnpq.br/<16 dígitos>".
const CV_RE = /lattes\.cnpq\.br\/(\d{16})/;

/** Espera a página do CV (sem captcha e com o ID Lattes no HTML); sobrevive às navegações. */
async function esperarCV(page: Page, ms: number): Promise<string | null> {
  const fim = Date.now() + ms;
  while (state.rodando && Date.now() < fim) {
    const html = await page.content().catch(() => '');
    if (html && CV_RE.test(html) && !(await temCaptcha(page).catch(() => true))) return html;
    await sleep(2000);
  }
  return null;
}

// O Lattes não serve mais o XML público (download.do responde vazio): o caminho é a página
// do CV (cv?id= -> visualizacv.do, reCAPTCHA v2 + "Submeter"), que devolve o currículo em HTML.
async function baixar(id: string): Promise<'ok' | 'sem_cv' | 'timeout'> {
  const c = await contexto();
  const page = c.pages()[0] ?? (await c.newPage());
  set('abrindo', `abrindo ${id}`, id);
  await page.goto(config.lattesCvUrl.replace('{id}', id), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(1500);

  // ID que não existe (ou CV removido): o Lattes redireciona para erro.jsp.
  if (/\/erro\.jsp/.test(page.url())) {
    await pool.query(
      `UPDATE fila SET status='sem_cv', ultimo_erro='CV não existe no Lattes (o ID redireciona para erro.jsp)', atualizado_em=now() WHERE lattes_id=$1`,
      [id],
    );
    return 'sem_cv';
  }

  if (await temCaptcha(page)) {
    const { chave } = await chave2Captcha();
    if (chave) {
      const html = await resolverAuto(page, id, chave);
      if (html) return await salvar(id, html);
      // Sem sitekey ou o token não abriu o CV: deixa para uma pessoa.
    }
    await pool.query(`UPDATE fila SET status='aguardando_captcha', atualizado_em=now() WHERE lattes_id=$1`, [id]);
    set('aguardando_captcha', `resolva o captcha de ${id} no navegador (noVNC) e clique em Submeter`, id);
    const html = await esperarCV(page, config.captchaTimeoutMs);
    if (!html) return 'timeout';
    return await salvar(id, html);
  }
  const html = await page.content();
  if (CV_RE.test(html)) return await salvar(id, html);
  // Nem captcha nem CV: guarda a página para diagnóstico.
  const debug = salvarDebug(id, html);
  await pool.query(
    `UPDATE fila SET status='sem_cv', ultimo_erro=$2, atualizado_em=now() WHERE lattes_id=$1`,
    [id, `página sem captcha e sem CV (${page.url().slice(0, 120)}); salva em ${debug}`],
  );
  return 'sem_cv';
}

async function resolverAuto(page: Page, id: string, chave: string): Promise<string | null> {
  // O widget é renderizado depois que o api.js carrega (render=explicit).
  await page.waitForSelector('iframe[src*="recaptcha"]', { timeout: 20_000 }).catch(() => {});
  const sitekey = await page.evaluate(() => {
    const d = (globalThis as any).document;
    const el = d.querySelector('[data-sitekey]');
    if (el) return el.getAttribute('data-sitekey') as string;
    const f = d.querySelector('iframe[src*="recaptcha"]');
    if (f) return new URL(f.src).searchParams.get('k');
    return /'sitekey'\s*:\s*'([^']+)'/.exec(d.documentElement.innerHTML)?.[1] ?? null;
  });
  if (!sitekey) return null;
  set('resolvendo_captcha', `resolvendo o captcha de ${id} via 2Captcha`, id);
  const token = await resolverRecaptcha(chave, sitekey, page.url());

  // Mesmo efeito do callback da página + "Submeter": token nos dois campos e envia o form.
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => null),
    page.evaluate((token) => {
      const d = (globalThis as any).document;
      for (const t of d.querySelectorAll('textarea[name="g-recaptcha-response"]')) t.value = token;
      const campo = d.getElementById('tokenCaptchar');
      if (campo) campo.value = token;
      d.forms[0].submit();
    }, token),
  ]);
  return await esperarCV(page, 15_000);
}

function salvarDebug(id: string, html: string): string {
  const dir = path.join(paths.html(), '_debug');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}-${Date.now()}.html`);
  fs.writeFileSync(file, html);
  return file;
}

async function salvar(id: string, html: string): Promise<'ok'> {
  set('baixando', `salvando ${id}`, id);
  const achado = CV_RE.exec(html)?.[1];
  if (achado !== id) throw new Error(`a página aberta é do CV ${achado}, esperado ${id}; salva em ${salvarDebug(id, html)}`);
  await saveHtml(id, html);
  state.baixadosNaSessao++;
  return 'ok';
}

export async function aguardarFim(): Promise<void> {
  await loopPromise;
}
