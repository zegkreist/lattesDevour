import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { config, paths } from './config.js';
import { pool } from './db.js';

// Cópia do banco em arquivos abertos: um <tabela>.parquet por tabela (compressão GZIP dentro do
// Parquet), em data/exports, sobrescritos a cada exportação. Sem senha: abre direto no pandas,
// DuckDB, Spark, Power BI. O DuckDB lê o Postgres pela extensão postgres (baixada uma vez para
// data/duckdb-ext) e preserva os tipos: text[] vira lista, jsonb vira texto JSON.
// Fica de fora o que é segredo ou interno: settings guarda a chave do 2Captcha.
const FORA = new Set(['settings', 'schema_migrations']);

const sql = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

let exportando = false;

export async function exportarParquet(): Promise<{ dir: string; tabelas: { tabela: string; linhas: number; bytes: number }[] }> {
  if (exportando) throw new Error('exportação já em andamento');
  exportando = true;
  const dir = paths.exports();
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(paths.duckdbExt(), { recursive: true });
  const db = await DuckDBInstance.create(':memory:');
  const con = await db.connect();
  try {
    await con.run(`SET extension_directory = ${sql(paths.duckdbExt())}`);
    await con.run('INSTALL postgres');
    await con.run('LOAD postgres');
    await con.run(`ATTACH ${sql(config.databaseUrl)} AS pg (TYPE postgres, READ_ONLY)`);

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
    con.closeSync();
    db.closeSync();
    exportando = false;
  }
}
