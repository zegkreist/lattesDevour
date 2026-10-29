// Normalização usada em TUDO que vai para colunas *_norm e para as buscas: minúsculas,
// sem acento, sem pontuação. A mesma função roda no insert e na query, senão não casa.
export function norm(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function slug(s: string): string {
  return norm(s).replace(/ /g, '-');
}

export function toInt(s: unknown): number | null {
  const n = parseInt(String(s ?? ''), 10);
  return Number.isFinite(n) ? n : null;
}

export function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

export function clean(s: unknown): string | null {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t ? t : null;
}
