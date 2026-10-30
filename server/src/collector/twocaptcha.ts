import { config } from '../config.js';
import { getSetting } from '../db.js';

// Cliente mínimo do 2Captcha (API clássica in.php/res.php) para reCAPTCHA v2.
// Só é usado quando há chave (aba Coleta ou TWOCAPTCHA_API_KEY); sem chave o coletor segue 100% humano.

const BASE = 'https://2captcha.com';

// Erros que não melhoram tentando outro CV (chave errada, sem saldo, IP bloqueado):
// o coletor pausa em vez de continuar gastando requisições.
const FATAIS = new Set([
  'ERROR_WRONG_USER_KEY',
  'ERROR_KEY_DOES_NOT_EXIST',
  'ERROR_ZERO_BALANCE',
  'ERROR_IP_NOT_ALLOWED',
  'IP_BANNED',
]);

export class Erro2Captcha extends Error {
  constructor(public codigo: string, public fatal = FATAIS.has(codigo)) {
    super(`2captcha: ${codigo}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Chave salva pelo painel; se vazia, a do .env. */
export async function chave2Captcha(): Promise<{ chave: string; origem: 'painel' | 'env' | null }> {
  const painel = await getSetting<string>('coleta.twocaptcha_key', '');
  if (painel) return { chave: painel, origem: 'painel' };
  return config.twoCaptcha.apiKey ? { chave: config.twoCaptcha.apiKey, origem: 'env' } : { chave: '', origem: null };
}

async function chamar(url: string, init?: RequestInit): Promise<{ status: number; request: string }> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Erro2Captcha(`HTTP_${r.status}`);
  return (await r.json()) as { status: number; request: string };
}

/** Saldo em US$; serve também para validar a chave. */
export async function saldo(key: string): Promise<number> {
  const r = await chamar(`${BASE}/res.php?${new URLSearchParams({ key, action: 'getbalance', json: '1' })}`);
  if (r.status !== 1) throw new Erro2Captcha(r.request);
  return Number(r.request);
}

export async function resolverRecaptcha(key: string, sitekey: string, pageurl: string): Promise<string> {
  const envio = await chamar(`${BASE}/in.php`, {
    method: 'POST',
    body: new URLSearchParams({ key, method: 'userrecaptcha', googlekey: sitekey, pageurl, json: '1' }),
  });
  if (envio.status !== 1) throw new Erro2Captcha(envio.request);

  // A doc do 2Captcha pede 15–20 s antes da primeira consulta e 5 s entre consultas.
  await sleep(20_000);
  const limite = Date.now() + config.twoCaptcha.timeoutMs;
  while (Date.now() < limite) {
    const r = await chamar(`${BASE}/res.php?${new URLSearchParams({ key, action: 'get', id: envio.request, json: '1' })}`);
    if (r.status === 1) return r.request;
    if (r.request !== 'CAPCHA_NOT_READY') throw new Erro2Captcha(r.request);
    await sleep(5000);
  }
  throw new Erro2Captcha('TIMEOUT');
}
