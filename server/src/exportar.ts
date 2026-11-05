import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { zipSync } from 'fflate';
import { config, paths } from './config.js';
import { pool } from './db.js';

// Cópia do banco em arquivos abertos: um <tabela>.parquet por tabela (compressão GZIP dentro do
// Parquet), em data/exports, sobrescritos a cada exportação. Sem senha: abre direto no pandas,
// DuckDB, Spark, Power BI. O DuckDB lê o Postgres pela extensão postgres (baixada uma vez para
// data/duckdb-ext) e preserva os tipos: text[] vira lista, jsonb vira texto JSON.
// Fica de fora o que é segredo ou interno: settings guarda a chave do 2Captcha.
export const FORA = new Set(['settings', 'schema_migrations']);

export const sql = (s: string) => `'${s.replace(/'/g, "''")}'`;
export const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** DuckDB em memória com o Postgres anexado como `pg`. A extensão é baixada uma vez para data/duckdb-ext. */
export async function duckdbComPostgres(modo: 'leitura' | 'escrita') {
  fs.mkdirSync(paths.duckdbExt(), { recursive: true });
  const db = await DuckDBInstance.create(':memory:');
  const con = await db.connect();
  const fechar = () => { con.closeSync(); db.closeSync(); };
  try {
    await con.run(`SET extension_directory = ${sql(paths.duckdbExt())}`);
    await con.run('INSTALL postgres');
    await con.run('LOAD postgres');
    await con.run(`ATTACH ${sql(config.databaseUrl)} AS pg (TYPE postgres${modo === 'leitura' ? ', READ_ONLY' : ''})`);
  } catch (e) {
    fechar();
    throw e;
  }
  return { con, fechar };
}

/** A exportação atual num .zip, para levar a outro Lattes Devour. O Parquet já vem comprimido: só empacota. */
export function zipDaExportacao(dir = paths.exports()): Uint8Array | null {
  const nomes = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.parquet')) : [];
  if (!nomes.length) return null;
  return zipSync(Object.fromEntries(nomes.map((f) => [f, [fs.readFileSync(path.join(dir, f)), { level: 0 }]])));
}

let exportando = false;

export async function exportarParquet(dir = paths.exports()): Promise<{ dir: string; tabelas: { tabela: string; linhas: number; bytes: number }[] }> {
  if (exportando) throw new Error('exportação já em andamento');
  exportando = true;
  let fechar = () => {};
  try {
    fs.mkdirSync(dir, { recursive: true });
    const duck = await duckdbComPostgres('leitura');
    const { con } = duck;
    fechar = duck.fechar;

    // tsvector é só o índice de busca (derivado) e o DuckDB não o lê: fica de fora.
    const { rows } = await pool.query<{ tabela: string; colunas: string[] }>(
      `SELECT table_name AS tabela, array_agg(column_name::text ORDER BY ordinal_position) AS colunas
       FROM information_schema.columns
       WHERE table_schema = 'public' AND udt_name <> 'tsvector'
       GROUP BY table_name ORDER BY table_name`,
    );
    const tabelas = [];
    for (const { tabela, colunas } of rows.filter((r) => !FORA.has(r.tabela))) {
      const arquivo = path.join(dir, `${tabela}.parquet`);
      await con.run(
        `COPY (SELECT ${colunas.map(ident).join(', ')} FROM pg.public.${ident(tabela)})
         TO ${sql(arquivo + '.tmp')} (FORMAT parquet, COMPRESSION gzip)`,
      );
      fs.renameSync(arquivo + '.tmp', arquivo);
      const r = await con.runAndReadAll(`SELECT count(*)::INTEGER FROM read_parquet(${sql(arquivo)})`);
      tabelas.push({ tabela, linhas: Number(r.getRows()[0][0]), bytes: fs.statSync(arquivo).size });
    }
    return { dir, tabelas };
  } finally {
    fechar();
    exportando = false;
  }
}
