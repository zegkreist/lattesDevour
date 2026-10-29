import { useEffect, useRef, useState } from 'react';

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.erro ?? `HTTP ${r.status}`);
  return r.json();
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Busca periódica; mantém o último dado enquanto recarrega. */
export function usePoll<T>(path: string, ms = 0): { data: T | null; erro: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const run = () => api<T>(path).then((d) => alive.current && (setData(d), setErro(null))).catch((e) => alive.current && setErro(String(e.message ?? e)));
    run();
    const t = ms ? setInterval(run, ms) : undefined;
    return () => { alive.current = false; if (t) clearInterval(t); };
  }, [path, ms, tick]);
  return { data, erro, reload: () => setTick((x) => x + 1) };
}
