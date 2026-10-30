import { afterEach, describe, expect, it, vi } from 'vitest';
import { Erro2Captcha, resolverRecaptcha, saldo } from '../src/collector/twocaptcha.js';

const resp = (status: number, request: string) => new Response(JSON.stringify({ status, request }));

describe('2captcha', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('envia o sitekey e consulta até o token ficar pronto', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(resp(1, '123'))
      .mockResolvedValueOnce(resp(0, 'CAPCHA_NOT_READY'))
      .mockResolvedValueOnce(resp(1, 'TOKEN'));
    vi.stubGlobal('fetch', fetch);
    const p = resolverRecaptcha('k', 'site', 'https://x/y');
    await vi.runAllTimersAsync();
    expect(await p).toBe('TOKEN');
    expect(String(fetch.mock.calls[0][1].body)).toContain('googlekey=site');
    expect(fetch.mock.calls[2][0]).toContain('id=123');
  });

  it('saldo valida a chave', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(resp(1, '3.75')).mockResolvedValueOnce(resp(0, 'ERROR_WRONG_USER_KEY')));
    expect(await saldo('k')).toBe(3.75);
    expect((await saldo('x').catch((e) => e)).fatal).toBe(true);
  });

  it('sem saldo é fatal (pausa a coleta)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(0, 'ERROR_ZERO_BALANCE')));
    const e = await resolverRecaptcha('k', 'site', 'u').catch((x) => x);
    expect(e).toBeInstanceOf(Erro2Captcha);
    expect(e.fatal).toBe(true);
  });

  it('captcha insolúvel não é fatal (só aquele CV conta tentativa)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(resp(1, '9')).mockResolvedValue(resp(0, 'ERROR_CAPTCHA_UNSOLVABLE')));
    const p = resolverRecaptcha('k', 'site', 'u').catch((x) => x);
    await vi.runAllTimersAsync();
    expect((await p).fatal).toBe(false);
  });
});
