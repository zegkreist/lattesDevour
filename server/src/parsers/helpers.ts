import { clean, toInt, uniq } from '../util/text.js';
import type { Node, ParsedAutor } from './types.js';

export const ATTR = '@_';

export function arr<T = Node>(x: unknown): T[] {
  if (x === undefined || x === null || x === '') return [];
  return (Array.isArray(x) ? x : [x]) as T[];
}

export function attr(n: Node | undefined, name: string): string | null {
  return n ? clean(n[ATTR + name]) : null;
}

export function attrs(n: Node | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!n || typeof n !== 'object') return out;
  for (const [k, v] of Object.entries(n)) {
    if (k.startsWith(ATTR)) {
      const t = clean(v);
      if (t) out[k.slice(ATTR.length)] = t;
    }
  }
  return out;
}

/** Filhos que são elementos (não atributos), como [nome, valor]. */
export function children(n: Node | undefined): [string, Node][] {
  const out: [string, Node][] = [];
  if (!n || typeof n !== 'object') return out;
  for (const [k, v] of Object.entries(n)) {
    if (k.startsWith(ATTR) || k.startsWith('#')) continue;
    for (const item of arr(v)) out.push([k, typeof item === 'object' && item ? (item as Node) : {}]);
  }
  return out;
}

export function firstAttr(a: Record<string, string>, pred: (k: string) => boolean): string | null {
  const k = Object.keys(a).find(pred);
  return k ? a[k] : null;
}

export function palavrasChave(node: Node): string[] {
  const a = attrs(arr(node['PALAVRAS-CHAVE'])[0]);
  return uniq(
    Object.entries(a)
      .filter(([k]) => k.startsWith('PALAVRA-CHAVE'))
      .map(([, v]) => v),
  );
}

export function areasDoConhecimento(node: Node): { grandes: string[]; areas: string[] } {
  const grandes: string[] = [];
  const areas: string[] = [];
  for (const [, area] of children(arr(node['AREAS-DO-CONHECIMENTO'])[0])) {
    const a = attrs(area);
    if (a['NOME-GRANDE-AREA-DO-CONHECIMENTO']) grandes.push(a['NOME-GRANDE-AREA-DO-CONHECIMENTO']);
    if (a['NOME-DA-AREA-DO-CONHECIMENTO']) areas.push(a['NOME-DA-AREA-DO-CONHECIMENTO']);
  }
  return { grandes: uniq(grandes), areas: uniq(areas) };
}

export function autores(node: Node): ParsedAutor[] {
  return arr(node['AUTORES']).map((a, i) => {
    const x = attrs(a);
    const id = x['NRO-ID-CNPQ'];
    const ordem = toInt(x['ORDEM-DE-AUTORIA']) ?? i + 1;
    return {
      ordem: ordem > 0 ? ordem : i + 1,
      nome: x['NOME-COMPLETO-DO-AUTOR'] ?? x['NOME-PARA-CITACAO'] ?? '',
      nomeCitacao: x['NOME-PARA-CITACAO'] ?? null,
      lattesId: id && /^\d{16}$/.test(id) ? id : null,
    };
  }).filter((a) => a.nome);
}
