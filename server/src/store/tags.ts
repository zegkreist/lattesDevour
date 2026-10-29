import type { ParsedCV, ParsedObra } from '../parsers/types.js';
import { regiaoDaUf } from '../util/regions.js';
import { norm, slug, uniq } from '../util/text.js';

export interface Contexto {
  uf: string | null;
  regiao: string | null;
  instSlug: string | null;
}

export function contextoDe(cv: ParsedCV): Contexto {
  const uf = cv.instituicao?.uf ?? null;
  return {
    uf,
    regiao: regiaoDaUf(uf),
    instSlug: cv.instituicao ? slug(cv.instituicao.nome) : null,
  };
}

// Tags "tipo:valor" — o que a busca do site filtra com `tags @> ARRAY[...]`.
export function tagsDoPesquisador(cv: ParsedCV, ctx: Contexto): string[] {
  return uniq([
    ...(ctx.uf ? [`uf:${ctx.uf}`] : []),
    ...(ctx.regiao ? [`regiao:${ctx.regiao}`] : []),
    ...(ctx.instSlug ? [`inst:${ctx.instSlug}`] : []),
    ...cv.grandesAreas.map((a) => `tema:${slug(a)}`),
    ...cv.areas.map((a) => `area:${slug(a)}`),
  ]);
}

export function tagsDaObra(o: ParsedObra, ctx: Contexto): string[] {
  return uniq([
    `tipo:${o.tipo}`,
    ...(o.ano ? [`ano:${o.ano}`, `decada:${Math.floor(o.ano / 10) * 10}s`] : []),
    ...(o.idioma ? [`idioma:${slug(o.idioma)}`] : []),
    ...(o.doi ? ['tem-doi'] : []),
    ...(ctx.uf ? [`uf:${ctx.uf}`] : []),
    ...(ctx.regiao ? [`regiao:${ctx.regiao}`] : []),
    ...(ctx.instSlug ? [`inst:${ctx.instSlug}`] : []),
    ...o.grandesAreas.map((a) => `tema:${slug(a)}`),
    ...o.areas.map((a) => `area:${slug(a)}`),
    ...o.palavrasChave.slice(0, 12).map((k) => `kw:${slug(k)}`),
  ]).filter((t) => t.length > 3 && t.length < 120);
}

export function textoBusca(o: ParsedObra): string {
  return norm([o.titulo, o.veiculo ?? '', o.palavrasChave.join(' ')].join(' '));
}
