import type pg from 'pg';
import { pool } from '../db.js';
import { currentParserVersion } from '../parsers/index.js';
import type { ParsedCV } from '../parsers/types.js';
import { escolherUf, regiaoDaUf, ufPeloNome } from '../util/regions.js';
import { norm, uniq } from '../util/text.js';
import { contextoDe, tagsDaObra, tagsDoPesquisador, textoBusca } from './tags.js';

export interface IngestResult {
  obras: number;
  orientacoes: number;
}

// Grava um CV parseado numa transação. Idempotente: reprocessar o mesmo CV (ex.: parser
// novo) substitui o que o CV declarava, sem duplicar obras que outros CVs também declaram.
export async function ingest(
  cv: ParsedCV,
  meta: { parser: string; versao: number; xmlSha256: string },
): Promise<IngestResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await ingestTx(client, cv, meta);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Campos de obra com um valor só. Quem manda: uma fonte XML (mais completa e estruturada)
// sempre atualiza; uma fonte HTML atualiza se a obra não tem fonte XML, senão só preenche vazio.
// $19 = esta fonte é XML. As fontes deste CV já foram apagadas, então o EXISTS olha os outros CVs.
const CAMPOS_SIMPLES = ['subtipo', 'idioma', 'veiculo', 'issn', 'isbn', 'pais', 'doi'];
const preferido = (k: string) =>
  `CASE WHEN $19 OR NOT EXISTS (SELECT 1 FROM obra_fonte f WHERE f.obra_id = obra.id AND f.parser LIKE 'lattes-xml%')
     THEN COALESCE(EXCLUDED.${k}, obra.${k}) ELSE COALESCE(obra.${k}, EXCLUDED.${k}) END`;

interface AutorFonte { ordem: number; nome: string; nomeCitacao: string | null; lattesId: string | null }

/**
 * Refaz o que a obra herda das fontes (o que cada CV diz dela, em obra_fonte), para que
 * reprocessar um CV troque só a contribuição dele e nada velho fique para trás:
 * - dados: fusão chave a chave, em conflito vence a fonte XML;
 * - tags, palavras-chave e áreas: união das fontes;
 * - autoria: a lista da melhor fonte (XML; senão a mais completa), com o ID Lattes que qualquer
 *   fonte conheça para aquele nome, e o dono de cada CV-fonte resolvido pelo próprio nome.
 */
async function recomputarObras(c: pg.PoolClient, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const uniao = (col: string) =>
    `COALESCE((SELECT array_agg(DISTINCT t ORDER BY t) FROM obra_fonte f, unnest(f.${col}) t WHERE f.obra_id = o.id), '{}')`;
  await c.query(
    `UPDATE obra o SET
       dados = COALESCE((
         SELECT jsonb_object_agg(k, v) FROM (
           SELECT DISTINCT ON (e.key) e.key AS k, e.value AS v
           FROM obra_fonte f CROSS JOIN LATERAL jsonb_each(f.dados) e
           WHERE f.obra_id = o.id
           ORDER BY e.key, (f.parser LIKE 'lattes-xml%') DESC, f.pesquisador_id) x), '{}'),
       tags = ${uniao('tags')}, palavras_chave = ${uniao('palavras_chave')},
       grandes_areas = ${uniao('grandes_areas')}, areas = ${uniao('areas')}
     WHERE o.id = ANY($1::bigint[]) AND EXISTS (SELECT 1 FROM obra_fonte f WHERE f.obra_id = o.id)`,
    [ids],
  );

  const { rows } = await c.query<{ obra_id: string; pesquisador_id: string; parser: string | null; autores: AutorFonte[]; nome: string; nomes_citacao: string[] }>(
    `SELECT f.obra_id, f.pesquisador_id, f.parser, f.autores, p.nome, p.nomes_citacao
     FROM obra_fonte f JOIN pesquisador p ON p.id = f.pesquisador_id WHERE f.obra_id = ANY($1::bigint[])`,
    [ids],
  );
  const porObra = new Map<string, typeof rows>();
  for (const r of rows) porObra.set(r.obra_id, [...(porObra.get(r.obra_id) ?? []), r]);
  for (const [obraId, fontes] of porObra) {
    fontes.sort(
      (a, b) =>
        Number(!!b.parser?.startsWith('lattes-xml')) - Number(!!a.parser?.startsWith('lattes-xml')) ||
        b.autores.length - a.autores.length ||
        a.pesquisador_id.localeCompare(b.pesquisador_id),
    );
    const idPorNome = new Map<string, string>();
    for (const f of fontes) {
      for (const a of f.autores) {
        if (a.lattesId) for (const n of [a.nome, a.nomeCitacao]) if (n) idPorNome.set(norm(n), a.lattesId);
      }
      for (const n of [f.nome, ...(f.nomes_citacao ?? [])]) if (!idPorNome.has(norm(n))) idPorNome.set(norm(n), f.pesquisador_id);
    }
    const usados = new Set<string>();
    const autores = fontes[0].autores.map((a) => {
      let id = a.lattesId ?? idPorNome.get(norm(a.nome)) ?? (a.nomeCitacao ? idPorNome.get(norm(a.nomeCitacao)) : undefined) ?? null;
      if (id && usados.has(id)) id = null; // o mesmo pesquisador não ocupa duas posições
      if (id) usados.add(id);
      return { ...a, lattesId: id };
    });
    await c.query('DELETE FROM autoria WHERE obra_id = $1', [obraId]);
    if (autores.length) {
      await c.query(
        `INSERT INTO autoria (obra_id, ordem, nome, nome_norm, nome_citacao, autor_lattes_id)
         SELECT $1, x.ordem, x.nome, x.nome_norm, x.nome_citacao, x.autor
         FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[]) AS x(ordem, nome, nome_norm, nome_citacao, autor)
         ON CONFLICT DO NOTHING`,
        [obraId, autores.map((a) => a.ordem), autores.map((a) => a.nome), autores.map((a) => norm(a.nome)),
          autores.map((a) => a.nomeCitacao), autores.map((a) => a.lattesId)],
      );
    }
  }
}

async function ingestTx(
  c: pg.PoolClient,
  cv: ParsedCV,
  meta: { parser: string; versao: number; xmlSha256: string },
): Promise<IngestResult> {
  let ctx = contextoDe(cv);

  await c.query(
    `INSERT INTO fila (lattes_id, status, origem) VALUES ($1, 'baixado', 'import')
     ON CONFLICT (lattes_id) DO NOTHING`,
    [cv.lattesId],
  );

  let instId: number | null = null;
  if (cv.instituicao) {
    const i = cv.instituicao;
    // A UF da instituição vem do endereço do CV ou, sem ele, do próprio nome ("de Goiás", "USP").
    const ufInst = i.uf ?? ufPeloNome(i.nome);
    const r = await c.query(
      `WITH antes AS (SELECT uf FROM instituicao WHERE nome_norm = $3)
       INSERT INTO instituicao (codigo, nome, nome_norm, uf, regiao, pais) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (nome_norm) DO UPDATE SET uf = COALESCE(EXCLUDED.uf, instituicao.uf),
         regiao = COALESCE(EXCLUDED.regiao, instituicao.regiao), codigo = COALESCE(EXCLUDED.codigo, instituicao.codigo)
       RETURNING id, (SELECT uf FROM antes) AS uf_antes, uf`,
      [i.codigo, i.nome, norm(i.nome), ufInst, regiaoDaUf(ufInst), i.pais],
    );
    instId = r.rows[0].id;
    // A instituição acabou de ganhar UF: quem estava ligado a ela sem UF volta para o parse.
    if (r.rows[0].uf && !r.rows[0].uf_antes) {
      await c.query(
        `UPDATE fila SET status = CASE WHEN xml_path IS NOT NULL THEN 'baixado' ELSE 'html' END, atualizado_em = now()
         WHERE lattes_id <> $2 AND status = 'parseado'
           AND lattes_id IN (SELECT id FROM pesquisador WHERE instituicao_id = $1 AND uf IS NULL)`,
        [instId, cv.lattesId],
      );
    }
  }

  // Sem endereço profissional: UF inferida pela instituição atual e, depois, pelas da formação
  // (em andamento primeiro, depois a mais recente). Vale a UF já conhecida no banco para a
  // instituição (aprendida do endereço de outro CV) ou a deduzida do nome.
  if (!ctx.uf) {
    const formacao = [...cv.formacao].sort((a, b) =>
      Number(b.fim == null) - Number(a.fim == null) || (Number(b.fim) || 0) - (Number(a.fim) || 0));
    const candidatos = uniq([cv.instituicao?.nome, ...formacao.map((f) => f.instituicao as string | null)].filter((x): x is string => !!x));
    const conhecidas = new Map<string, string>(
      (await c.query(`SELECT nome_norm, uf FROM instituicao WHERE uf IS NOT NULL AND nome_norm = ANY($1)`, [candidatos.map(norm)]))
        .rows.map((r) => [r.nome_norm, r.uf]),
    );
    const achado = escolherUf(candidatos, conhecidas, norm);
    if (achado) {
      ctx = { ...ctx, uf: achado.uf, regiao: regiaoDaUf(achado.uf) };
      cv.avisos.push(`UF ${achado.uf} inferida pela instituição "${achado.instituicao}"`);
    }
  }

  const tsvPesq = norm(
    [cv.nome, cv.nomesCitacao.join(' '), cv.instituicao?.nome ?? '', cv.areas.join(' '), cv.grandesAreas.join(' ')].join(' '),
  );

  await c.query(
    `INSERT INTO pesquisador (id, nome, nome_norm, nomes_citacao, orcid, resumo, instituicao_id, uf, cidade, regiao,
        grandes_areas, areas, tags, formacao, atuacoes, data_atualizacao_cv, parser_versao, xml_sha256, coletado_em, tsv)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now(), to_tsvector('portuguese',$19))
     ON CONFLICT (id) DO UPDATE SET nome=EXCLUDED.nome, nome_norm=EXCLUDED.nome_norm, nomes_citacao=EXCLUDED.nomes_citacao,
        orcid=EXCLUDED.orcid, resumo=EXCLUDED.resumo, instituicao_id=EXCLUDED.instituicao_id, uf=EXCLUDED.uf,
        cidade=EXCLUDED.cidade, regiao=EXCLUDED.regiao, grandes_areas=EXCLUDED.grandes_areas, areas=EXCLUDED.areas,
        tags=EXCLUDED.tags, formacao=EXCLUDED.formacao, atuacoes=EXCLUDED.atuacoes,
        data_atualizacao_cv=EXCLUDED.data_atualizacao_cv, parser_versao=EXCLUDED.parser_versao,
        xml_sha256=EXCLUDED.xml_sha256, coletado_em=now(), tsv=EXCLUDED.tsv`,
    [
      cv.lattesId, cv.nome, norm(cv.nome), cv.nomesCitacao, cv.orcid, cv.resumo, instId, ctx.uf,
      cv.instituicao?.cidade ?? null, ctx.regiao, cv.grandesAreas, cv.areas, tagsDoPesquisador(cv, ctx),
      JSON.stringify(cv.formacao), JSON.stringify(cv.atuacoes), cv.dataAtualizacao, meta.versao, meta.xmlSha256, tsvPesq,
    ],
  );

  // Reprocesso: solta o que este CV declarava antes e re-declara.
  const antigas = (await c.query('DELETE FROM obra_fonte WHERE pesquisador_id=$1 RETURNING obra_id', [cv.lattesId])).rows.map(
    (r) => r.obra_id as string,
  );
  await c.query('DELETE FROM orientacao WHERE orientador_id=$1', [cv.lattesId]);

  const vistas = new Set<string>();
  const tocadas: string[] = [...antigas];
  const doXml = meta.parser.startsWith('lattes-xml');
  let nObras = 0;
  for (const o of cv.obras) {
    if (vistas.has(o.chave)) continue; // o mesmo CV repete a obra (ex.: DOI igual)
    vistas.add(o.chave);
    const tags = tagsDaObra(o, ctx);
    const r = await c.query(
      `INSERT INTO obra (chave, tipo, subtipo, titulo, titulo_norm, ano, doi, idioma, veiculo, issn, isbn, pais,
          palavras_chave, grandes_areas, areas, tags, dados, tsv)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, to_tsvector('portuguese',$18))
       ON CONFLICT (chave) DO UPDATE SET
         ${CAMPOS_SIMPLES.map((k) => `${k} = ${preferido(k)}`).join(', ')}
       RETURNING id`,
      [
        o.chave, o.tipo, o.subtipo, o.titulo, norm(o.titulo), o.ano, o.doi, o.idioma, o.veiculo, o.issn, o.isbn, o.pais,
        o.palavrasChave, o.grandesAreas, o.areas, tags, JSON.stringify(o.dados), textoBusca(o), doXml,
      ],
    );
    const obraId: string = r.rows[0].id;
    tocadas.push(obraId);
    // O que ESTE CV diz da obra; tags, autoria e dados da obra são refeitos a partir das fontes.
    await c.query(
      `INSERT INTO obra_fonte (obra_id, pesquisador_id, parser, dados, autores, tags, palavras_chave, grandes_areas, areas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (obra_id, pesquisador_id) DO UPDATE SET parser = EXCLUDED.parser, dados = EXCLUDED.dados,
         autores = EXCLUDED.autores, tags = EXCLUDED.tags, palavras_chave = EXCLUDED.palavras_chave,
         grandes_areas = EXCLUDED.grandes_areas, areas = EXCLUDED.areas`,
      [obraId, cv.lattesId, meta.parser, JSON.stringify(o.dados), JSON.stringify(o.autores), tags, o.palavrasChave, o.grandesAreas, o.areas],
    );
    nObras++;
  }

  for (const o of cv.orientacoes) {
    await c.query(
      `INSERT INTO orientacao (orientador_id, orientado_nome, orientado_lattes_id, nivel, titulo, ano, instituicao, curso)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [cv.lattesId, o.orientadoNome, o.orientadoLattesId, o.nivel, o.titulo, o.ano, o.instituicao, o.curso],
    );
  }

  await recomputarObras(c, tocadas);

  // Obras que só este CV declarava e que sumiram dele.
  if (antigas.length) {
    await c.query(
      `DELETE FROM obra o WHERE o.id = ANY($1::bigint[]) AND NOT EXISTS (SELECT 1 FROM obra_fonte f WHERE f.obra_id = o.id)`,
      [antigas],
    );
  }

  // Instituições que nenhum pesquisador usa mais (ex.: o CV mudou de instituição).
  await c.query(`DELETE FROM instituicao i WHERE NOT EXISTS (SELECT 1 FROM pesquisador p WHERE p.instituicao_id = i.id)`);

  await c.query(
    `INSERT INTO parse_log (pesquisador_id, parser, versao, obras, orientacoes, desconhecidos, avisos, em)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (pesquisador_id) DO UPDATE SET parser=EXCLUDED.parser, versao=EXCLUDED.versao, obras=EXCLUDED.obras,
       orientacoes=EXCLUDED.orientacoes, desconhecidos=EXCLUDED.desconhecidos, avisos=EXCLUDED.avisos, em=now()`,
    [cv.lattesId, meta.parser, meta.versao, nObras, cv.orientacoes.length, JSON.stringify(uniq(cv.desconhecidos)), JSON.stringify(cv.avisos.slice(0, 50))],
  );
  await c.query(`UPDATE fila SET status='parseado', ultimo_erro=NULL, atualizado_em=now() WHERE lattes_id=$1`, [cv.lattesId]);
  return { obras: nObras, orientacoes: cv.orientacoes.length };
}

export { currentParserVersion };
