import fs from 'node:fs';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { config, paths } from '../config.js';
import { getSetting, pool } from '../db.js';
import { extractXml } from '../util/xmlfile.js';
import { saveXml } from './pipeline.js';

// Coletor com humano no circuito. O Lattes protege a busca e o download do XML com
// reCAPTCHA v2. Este coletor NÃO tenta resolver nem contornar o captcha (sem serviços de
// quebra): abre o currículo num Chromium visível (Xvfb + noVNC), marca a fila como
// 'aguardando_captcha' e espera uma pessoa resolver e confirmar o download. Cada captcha
// resolvido destrava um currículo; o gargalo é humano por desenho. Para volume, o caminho
// é o Extrator Lattes do CNPq: coloque o zip/XML em data/import.

export interface CollectorState {
  rodando: boolean;
  atual: string | null;
  fase: 'ocioso' | 'abrindo' | 'aguardando_captcha' | 'baixando' | 'pausado';
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

let ctx: BrowserContext | null = null;
let loopPromise: Promise<void> | null = null;

function set(fase: CollectorState['fase'], mensagem: string, atual: string | null = state.atual) {
  state.fase = fase;
  state.mensagem = mensagem;
  state.atual = atual;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    const job = await proximo();
    if (!job) {
      set('ocioso', 'fila vazia: aguardando novos IDs', null);
      await sleep(5000);
      continue;
    }
    const id = job.lattes_id;
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
      const erro = e instanceof Error ? e.message : String(e);
      await pool.query(
        `UPDATE fila SET status = CASE WHEN tentativas >= 3 THEN 'erro' ELSE 'pendente' END, ultimo_erro=$2, atualizado_em=now() WHERE lattes_id=$1`,
        [id, erro.slice(0, 500)],
      );
    }
    const delay = await getSetting<number>('coleta.delay_ms', 8000);
    await sleep(delay + Math.random() * delay * 0.5);
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

async function salvar(id: string, dl: import('playwright').Download): Promise<'ok'> {
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
