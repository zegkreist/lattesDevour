import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type pg from 'pg';
import { pool } from './db.js';
import { duckdbComPostgres, ident, sql } from './exportar.js';
import { recomputarObras } from './store/ingest.js';
import { textoBusca, textoPesquisador } from './store/tags.js';

// Importa a cópia em Parquet de outro Lattes Devour. CV que só existe na cópia entra; CV que existe
// nas duas bases fica na versão mais recente no Lattes (data_atualizacao_cv) e, no empate, na maior
// (obras + orientações); persistindo o empate, fica o daqui. Por isso importar duas vezes não muda
// nada, e numa base vazia equivale a restaurar. A chave de cada coisa é a natural (ID Lattes, chave
// da obra, nome da instituição), pois os ids numéricos das duas bases não têm relação. As obras são
// refeitas a partir das fontes (obra_fonte), como no reprocesso. Os arquivos crus não vêm na cópia:
// fila.xml_path/html_path ficam nulos e CV importado não volta para o parse, nem por um arquivo
// antigo que tenha ficado em disco (ver reprocessar).

/** O zip é lido em memória. 1 GiB equivale a dezenas de milhares de CVs. */
export const LIMITE_ZIP = 1024 ** 3;

/** Colunas usadas de cada tabela da cópia. O resto da cópia é ignorado (view orientador, backup_log, autoria...). */
const TABELAS: Record<string, string[]> = {
  fila: ['lattes_id', 'status', 'nome_hint', 'ultimo_erro', 'criado_em'],
  instituicao: ['id', 'codigo', 'nome', 'nome_norm', 'uf', 'regiao', 'pais'],
  pesquisador: ['id', 'nome', 'nome_norm', 'nomes_citacao', 'orcid', 'resumo', 'instituicao_id', 'uf', 'cidade', 'regiao', 'grandes_areas',
    'areas', 'tags', 'formacao', 'atuacoes', 'data_atualizacao_cv', 'parser_versao', 'xml_sha256', 'coletado_em'],
  obra: ['id', 'chave', 'tipo', 'subtipo', 'titulo', 'titulo_norm', 'ano', 'doi', 'idioma', 'veiculo', 'issn', 'isbn', 'pais',
    'palavras_chave', 'grandes_areas', 'areas', 'tags', 'dados', 'criado_em'],
  obra_fonte: ['obra_id', 'pesquisador_id', 'parser', 'dados', 'autores', 'tags', 'palavras_chave', 'grandes_areas', 'areas'],
  orientacao: ['orientador_id', 'orientado_nome', 'orientado_lattes_id', 'nivel', 'titulo', 'ano', 'instituicao', 'curso'],
  parse_log: ['pesquisador_id', 'parser', 'versao', 'obras', 'orientacoes', 'desconhecidos', 'avisos', 'em'],
};
/** jsonb vira texto no Parquet: entra como texto na área temporária e volta a jsonb ao gravar. */
const JSONB = new Set(['formacao', 'atuacoes', 'dados', 'autores', 'desconhecidos', 'avisos']);
const AREA = 'importacao';
const ORIENTACAO_ZIP = 'use o .zip baixado em Configurações → Cópia em Parquet';

export interface ResultadoImport {
  cvsNovos: number;
  cvsAtualizados: number;
  cvsMantidos: number;
  obrasNovas: number;
  naFila: number;
}

/** Só os <tabela>.parquet conhecidos saem do zip, pelo nome-base: nenhum caminho do zip é usado. */
function extrair(zip: Uint8Array, dir: string): void {
  const base = (nome: string) => nome.split(/[\\/]/).pop() ?? '';
  const vistos = new Set<string>();
  let arquivos: Record<string, Uint8Array>;
  try {
    arquivos = unzipSync(zip, {
      filter: (f) => {
        const b = base(f.name);
        if (!b.endsWith('.parquet') || !(b.slice(0, -'.parquet'.length) in TABELAS)) return false;
        if (vistos.has(b)) throw new Error(`o zip tem mais de um ${b}: inclua uma exportação só`);
        vistos.add(b);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes('mais de um')) throw e;
    throw new Error(`não é um .zip válido; ${ORIENTACAO_ZIP}`);
  }
  for (const t of Object.keys(TABELAS)) {
    if (!vistos.has(`${t}.parquet`)) throw new Error(`o zip não tem ${t}.parquet; ${ORIENTACAO_ZIP}`);
  }
  for (const [nome, dados] of Object.entries(arquivos)) fs.writeFileSync(path.join(dir, base(nome)), dados);
}

/** Copia os Parquet para tabelas temporárias no Postgres, de onde a mescla é feita em SQL. */
async function carregarAreaTemporaria(dir: string): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS ${AREA} CASCADE; CREATE SCHEMA ${AREA}`);
  const { con, fechar } = await duckdbComPostgres('escrita');
  try {
    for (const [tabela, colunas] of Object.entries(TABELAS)) {
      const arquivo = sql(path.join(dir, `${tabela}.parquet`));
      const presentes = new Set((await con.runAndReadAll(`SELECT column_name FROM (DESCRIBE SELECT * FROM read_parquet(${arquivo}))`)).getRows().map((r) => String(r[0])));
      const falta = colunas.find((c) => !presentes.has(c));
      if (falta) throw new Error(`${tabela}.parquet não tem a coluna ${falta}: exportação de uma versão incompatível`);
      const select = colunas.map((c) => (JSONB.has(c) ? `CAST(${ident(c)} AS VARCHAR) AS ${ident(c)}` : ident(c))).join(', ');
      await con.run(`CREATE TABLE pg.${AREA}.${ident(tabela)} AS SELECT ${select} FROM read_parquet(${arquivo})`);
    }
  } finally {
    fechar();
  }
}

/** tsvector não vai na cópia: é refeito com a mesma normalização da gravação normal. */
async function reindexar(c: pg.PoolClient, cvs: string[], obrasNovas: string[]): Promise<void> {
  const emLotes = async (tabela: string, itens: { id: string; texto: string }[], tipo: string) => {
    for (let i = 0; i < itens.length; i += 2000) {
      const lote = itens.slice(i, i + 2000);
      await c.query(
        `UPDATE ${tabela} t SET tsv = to_tsvector('portuguese', x.texto)
         FROM unnest($1::${tipo}[], $2::text[]) AS x(id, texto) WHERE t.id = x.id`,
        [lote.map((l) => l.id), lote.map((l) => l.texto)],
      );
    }
  };
  const pesquisadores = await c.query(
    `SELECT p.id, p.nome, p.nomes_citacao, i.nome AS instituicao, p.areas, p.grandes_areas
     FROM pesquisador p LEFT JOIN instituicao i ON i.id = p.instituicao_id WHERE p.id = ANY($1::text[])`,
    [cvs],
  );
  await emLotes('pesquisador', pesquisadores.rows.map((p) => ({ id: p.id, texto: textoPesquisador(p.nome, p.nomes_citacao, p.instituicao, p.areas, p.grandes_areas) })), 'text');
  const obras = await c.query(`SELECT id, titulo, veiculo, palavras_chave FROM obra WHERE id = ANY($1::bigint[])`, [obrasNovas]);
  await emLotes('obra', obras.rows.map((o) => ({ id: o.id, texto: textoBusca({ titulo: o.titulo, veiculo: o.veiculo, palavrasChave: o.palavras_chave }) })), 'bigint');
}

async function mesclar(c: pg.PoolClient): Promise<ResultadoImport> {
  // fila primeiro, a mesma ordem do ingest: um CV sendo gravado termina antes, e o próximo espera.
  await c.query('LOCK TABLE fila, instituicao, pesquisador, obra, obra_fonte, autoria, orientacao, parse_log IN SHARE ROW EXCLUSIVE MODE');
  const tamanhos = (esquema: string) =>
    `SELECT id, sum(n) AS n FROM (
       SELECT pesquisador_id AS id, count(*) AS n FROM ${esquema}.obra_fonte GROUP BY 1
       UNION ALL SELECT orientador_id, count(*) FROM ${esquema}.orientacao GROUP BY 1) x GROUP BY id`;
  const data = (t: string) => `COALESCE(${t}.data_atualizacao_cv, '-infinity'::date)`;
  // CV que está sendo baixado ou parseado aqui vai ter a versão mais nova que existe: fica de fora.
  await c.query(
    `CREATE TEMP TABLE entram ON COMMIT DROP AS
     WITH fora AS (${tamanhos(AREA)}), aqui AS (${tamanhos('public')})
     SELECT s.id, p.id IS NOT NULL AS ja_existia
     FROM ${AREA}.pesquisador s
     LEFT JOIN pesquisador p ON p.id = s.id
     LEFT JOIN fila f ON f.lattes_id = s.id
     LEFT JOIN fora ON fora.id = s.id LEFT JOIN aqui ON aqui.id = s.id
     WHERE p.id IS NULL OR (
       f.status NOT IN ('html', 'baixado', 'baixando', 'aguardando_captcha')
       AND (${data('s')} > ${data('p')}
         OR (${data('s')} = ${data('p')} AND COALESCE(fora.n, 0) > COALESCE(aqui.n, 0))))`,
  );
  const entram = (await c.query<{ id: string; ja_existia: boolean }>('SELECT id, ja_existia FROM entram')).rows;
  const total = Number((await c.query(`SELECT count(*) FROM ${AREA}.pesquisador`)).rows[0].count);
  const atualizados = entram.filter((e) => e.ja_existia).length;

  // Sem o arquivo cru, o que estava no meio do caminho na outra base volta a pendente aqui.
  // Quem já está aqui só muda para parseado se ainda não tinha sido baixado; se tem arquivo
  // esperando parse, o parse local segue e prevalece.
  const fila = await c.query<{ status: string }>(
    `INSERT INTO fila (lattes_id, status, origem, nome_hint, ultimo_erro, criado_em)
     SELECT f.lattes_id,
            CASE WHEN n.id IS NOT NULL THEN 'parseado' WHEN f.status IN ('erro', 'sem_cv') THEN f.status ELSE 'pendente' END,
            'importado', f.nome_hint, CASE WHEN n.id IS NULL AND f.status IN ('erro', 'sem_cv') THEN f.ultimo_erro END, f.criado_em
     FROM ${AREA}.fila f LEFT JOIN entram n ON n.id = f.lattes_id
     ON CONFLICT (lattes_id) DO UPDATE SET status = 'parseado', ultimo_erro = NULL, atualizado_em = now(),
       nome_hint = COALESCE(fila.nome_hint, EXCLUDED.nome_hint)
     WHERE EXCLUDED.status = 'parseado' AND fila.status IN ('pendente', 'erro', 'sem_cv')
     RETURNING status`,
  );

  // A versão daqui sai inteira. Sem os caminhos, o arquivo antigo em disco não a traz de volta.
  await c.query(
    `UPDATE fila f SET status = 'parseado', origem = 'importado', xml_path = NULL, html_path = NULL, ultimo_erro = NULL, atualizado_em = now()
     FROM entram e WHERE e.id = f.lattes_id AND e.ja_existia`,
  );
  const soltas = (await c.query<{ obra_id: string }>(
    `DELETE FROM obra_fonte f USING entram e WHERE f.pesquisador_id = e.id AND e.ja_existia RETURNING f.obra_id`,
  )).rows.map((r) => r.obra_id);
  await c.query(`DELETE FROM parse_log l USING entram e WHERE l.pesquisador_id = e.id AND e.ja_existia`);
  await c.query(`DELETE FROM pesquisador p USING entram e WHERE p.id = e.id AND e.ja_existia`); // orientacao vai junto

  await c.query(
    `INSERT INTO instituicao (codigo, nome, nome_norm, uf, regiao, pais)
     SELECT i.codigo, i.nome, i.nome_norm, i.uf, i.regiao, i.pais FROM ${AREA}.instituicao i
     WHERE i.id IN (SELECT s.instituicao_id FROM ${AREA}.pesquisador s JOIN entram n ON n.id = s.id)
     ON CONFLICT (nome_norm) DO UPDATE SET uf = COALESCE(instituicao.uf, EXCLUDED.uf),
       regiao = COALESCE(instituicao.regiao, EXCLUDED.regiao), codigo = COALESCE(instituicao.codigo, EXCLUDED.codigo)`,
  );
  await c.query(
    `INSERT INTO pesquisador (id, nome, nome_norm, nomes_citacao, orcid, resumo, instituicao_id, uf, cidade, regiao, grandes_areas, areas,
        tags, formacao, atuacoes, data_atualizacao_cv, parser_versao, xml_sha256, coletado_em)
     SELECT s.id, s.nome, s.nome_norm, s.nomes_citacao, s.orcid, s.resumo, i.id, s.uf, s.cidade, s.regiao, s.grandes_areas, s.areas,
        s.tags, s.formacao::jsonb, s.atuacoes::jsonb, s.data_atualizacao_cv, s.parser_versao, s.xml_sha256, s.coletado_em
     FROM ${AREA}.pesquisador s JOIN entram n ON n.id = s.id
     LEFT JOIN ${AREA}.instituicao si ON si.id = s.instituicao_id LEFT JOIN instituicao i ON i.nome_norm = si.nome_norm`,
  );

  // Obra já existente só preenche campo vazio; dados, tags e autoria são refeitos das fontes abaixo.
  const preenche = ['subtipo', 'doi', 'idioma', 'veiculo', 'issn', 'isbn', 'pais'].map((k) => `${k} = COALESCE(obra.${k}, EXCLUDED.${k})`).join(', ');
  const obras = await c.query<{ id: string; nova: boolean }>(
    `INSERT INTO obra (chave, tipo, subtipo, titulo, titulo_norm, ano, doi, idioma, veiculo, issn, isbn, pais, palavras_chave, grandes_areas, areas, tags, dados, criado_em)
     SELECT s.chave, s.tipo, s.subtipo, s.titulo, s.titulo_norm, s.ano, s.doi, s.idioma, s.veiculo, s.issn, s.isbn, s.pais,
        s.palavras_chave, s.grandes_areas, s.areas, s.tags, s.dados::jsonb, s.criado_em
     FROM ${AREA}.obra s
     WHERE s.id IN (SELECT f.obra_id FROM ${AREA}.obra_fonte f JOIN entram n ON n.id = f.pesquisador_id)
     ON CONFLICT (chave) DO UPDATE SET ${preenche}
     RETURNING id, (xmax = 0) AS nova`,
  );
  await c.query(
    `INSERT INTO obra_fonte (obra_id, pesquisador_id, parser, dados, autores, tags, palavras_chave, grandes_areas, areas)
     SELECT o.id, f.pesquisador_id, f.parser, f.dados::jsonb, f.autores::jsonb, f.tags, f.palavras_chave, f.grandes_areas, f.areas
     FROM ${AREA}.obra_fonte f JOIN entram n ON n.id = f.pesquisador_id
     JOIN ${AREA}.obra s ON s.id = f.obra_id JOIN obra o ON o.chave = s.chave`,
  );
  await c.query(
    `INSERT INTO orientacao (orientador_id, orientado_nome, orientado_lattes_id, nivel, titulo, ano, instituicao, curso)
     SELECT s.orientador_id, s.orientado_nome, s.orientado_lattes_id, s.nivel, s.titulo, s.ano, s.instituicao, s.curso
     FROM ${AREA}.orientacao s JOIN entram n ON n.id = s.orientador_id ON CONFLICT DO NOTHING`,
  );
  await c.query(
    `INSERT INTO parse_log (pesquisador_id, parser, versao, obras, orientacoes, desconhecidos, avisos, em)
     SELECT s.pesquisador_id, s.parser, s.versao, s.obras, s.orientacoes, s.desconhecidos::jsonb, s.avisos::jsonb, s.em
     FROM ${AREA}.parse_log s JOIN entram n ON n.id = s.pesquisador_id ON CONFLICT DO NOTHING`,
  );

  await recomputarObras(c, [...new Set([...soltas, ...obras.rows.map((o) => o.id)])]);
  // O que só a versão que saiu declarava: obra sem nenhuma fonte e instituição sem pesquisador.
  await c.query(`DELETE FROM obra o WHERE o.id = ANY($1::bigint[]) AND NOT EXISTS (SELECT 1 FROM obra_fonte f WHERE f.obra_id = o.id)`, [soltas]);
  await c.query(`DELETE FROM instituicao i WHERE NOT EXISTS (SELECT 1 FROM pesquisador p WHERE p.instituicao_id = i.id)`);
  const obrasNovas = obras.rows.filter((o) => o.nova).map((o) => o.id);
  await reindexar(c, entram.map((e) => e.id), obrasNovas);
  return {
    cvsNovos: entram.length - atualizados,
    cvsAtualizados: atualizados,
    cvsMantidos: total - entram.length,
    obrasNovas: obrasNovas.length,
    naFila: fila.rows.filter((r) => r.status === 'pendente').length,
  };
}

let importando = false;

export async function importarBase(zip: Uint8Array): Promise<ResultadoImport> {
  if (importando) throw new Error('importação já em andamento');
  importando = true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattes-import-'));
  try {
    extrair(zip, dir);
    await carregarAreaTemporaria(dir);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await mesclar(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await pool.query(`DROP SCHEMA IF EXISTS ${AREA} CASCADE`).catch(() => {});
    importando = false;
  }
}
