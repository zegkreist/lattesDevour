import type pg from 'pg';
import { pool } from '../db.js';
import { currentParserVersion } from '../parsers/index.js';
import type { ParsedCV } from '../parsers/types.js';
import { regiaoDaUf } from '../util/regions.js';
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

/** obra.dados = fusão do que cada CV diz, chave a chave; em conflito vence a fonte XML. */
async function fundirDados(c: pg.PoolClient, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await c.query(
    `UPDATE obra o SET dados = COALESCE((
       SELECT jsonb_object_agg(k, v) FROM (
         SELECT DISTINCT ON (e.key) e.key AS k, e.value AS v
         FROM obra_fonte f CROSS JOIN LATERAL jsonb_each(f.dados) e
         WHERE f.obra_id = o.id
         ORDER BY e.key, (f.parser LIKE 'lattes-xml%') DESC, f.pesquisador_id) x), '{}')
     WHERE o.id = ANY($1::bigint[]) AND EXISTS (SELECT 1 FROM obra_fonte f WHERE f.obra_id = o.id)`,
    [ids],
  );
}

async function ingestTx(
  c: pg.PoolClient,
  cv: ParsedCV,
  meta: { parser: string; versao: number; xmlSha256: string },
): Promise<IngestResult> {
  const ctx = contextoDe(cv);

  await c.query(
    `INSERT INTO fila (lattes_id, status, origem) VALUES ($1, 'baixado', 'import')
     ON CONFLICT (lattes_id) DO NOTHING`,
    [cv.lattesId],
  );

  let instId: number | null = null;
  if (cv.instituicao) {
    const i = cv.instituicao;
    const r = await c.query(
      `INSERT INTO instituicao (codigo, nome, nome_norm, uf, regiao, pais) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (nome_norm) DO UPDATE SET uf = COALESCE(EXCLUDED.uf, instituicao.uf),
         regiao = COALESCE(EXCLUDED.regiao, instituicao.regiao), codigo = COALESCE(EXCLUDED.codigo, instituicao.codigo)
       RETURNING id`,
      [i.codigo, i.nome, norm(i.nome), i.uf, regiaoDaUf(i.uf), i.pais],
    );
    instId = r.rows[0].id;
  }

  const nomesDono = uniq([norm(cv.nome), ...cv.nomesCitacao.map(norm)]).filter(Boolean);
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
         tags = COALESCE((SELECT array_agg(DISTINCT t) FROM unnest(obra.tags || EXCLUDED.tags) t), '{}'),
         palavras_chave = COALESCE((SELECT array_agg(DISTINCT t) FROM unnest(obra.palavras_chave || EXCLUDED.palavras_chave) t), '{}'),
         grandes_areas = COALESCE((SELECT array_agg(DISTINCT t) FROM unnest(obra.grandes_areas || EXCLUDED.grandes_areas) t), '{}'),
         areas = COALESCE((SELECT array_agg(DISTINCT t) FROM unnest(obra.areas || EXCLUDED.areas) t), '{}'),
         ${CAMPOS_SIMPLES.map((k) => `${k} = ${preferido(k)}`).join(', ')}
       RETURNING id, (xmax = 0) AS inserted`,
      [
        o.chave, o.tipo, o.subtipo, o.titulo, norm(o.titulo), o.ano, o.doi, o.idioma, o.veiculo, o.issn, o.isbn, o.pais,
        o.palavrasChave, o.grandesAreas, o.areas, tags, JSON.stringify(o.dados), textoBusca(o), doXml,
      ],
    );
    const obraId: string = r.rows[0].id;
    tocadas.push(obraId);
    await c.query(
      `INSERT INTO obra_fonte (obra_id, pesquisador_id, parser, dados) VALUES ($1,$2,$3,$4)
       ON CONFLICT (obra_id, pesquisador_id) DO UPDATE SET parser = EXCLUDED.parser, dados = EXCLUDED.dados`,
      [obraId, cv.lattesId, meta.parser, JSON.stringify(o.dados)],
    );

    // Autoria vem do primeiro CV que declarou a obra (ou do primeiro com lista não-vazia).
    const tem = r.rows[0].inserted
      ? false
      : (await c.query('SELECT 1 FROM autoria WHERE obra_id=$1 LIMIT 1', [obraId])).rowCount! > 0;
    if (!tem) {
      for (const a of o.autores) {
        await c.query(
          `INSERT INTO autoria (obra_id, ordem, nome, nome_norm, nome_citacao, autor_lattes_id)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [obraId, a.ordem, a.nome, norm(a.nome), a.nomeCitacao, a.lattesId],
        );
      }
    }
    // O dono do CV nem sempre vem com NRO-ID-CNPQ na própria lista: resolve por nome.
    // Só preenche autor ainda sem ID, e só com nome idêntico ao do dono (nome completo ou citação).
    await c.query(
      `UPDATE autoria SET autor_lattes_id = $2
       WHERE obra_id = $1 AND autor_lattes_id IS NULL
         AND (nome_norm = ANY($3) OR regexp_replace(lower(nome_citacao), '[^a-z0-9]+', ' ', 'g') = ANY($3))
         AND NOT EXISTS (SELECT 1 FROM autoria x WHERE x.obra_id = $1 AND x.autor_lattes_id = $2)`,
      [obraId, cv.lattesId, nomesDono],
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

  await fundirDados(c, tocadas);

  // Obras que só este CV declarava e que sumiram dele.
  if (antigas.length) {
    await c.query(
      `DELETE FROM obra o WHERE o.id = ANY($1::bigint[]) AND NOT EXISTS (SELECT 1 FROM obra_fonte f WHERE f.obra_id = o.id)`,
      [antigas],
    );
  }

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
