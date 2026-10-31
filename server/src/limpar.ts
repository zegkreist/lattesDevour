import crypto from 'node:crypto';
import path from 'node:path';
import { config, paths } from './config.js';
import * as coletor from './collector/collector.js';
import { pool } from './db.js';
import { exportarParquet, FORA } from './exportar.js';

/** A senha é a do próprio banco, a mesma da DATABASE_URL. */
export function senhaConfere(senha: string): boolean {
  const esperada = decodeURIComponent(new URL(config.databaseUrl).password);
  const a = crypto.createHash('sha256').update(senha).digest();
  const b = crypto.createHash('sha256').update(esperada).digest();
  return !!esperada && crypto.timingSafeEqual(a, b);
}

let limpando = false;

/**
 * Esvazia o banco depois de gravar uma cópia em Parquet (data/exports/antes-de-limpar-<data>, numa
 * pasta própria para não sobrescrever a exportação normal). Se a cópia falhar ou não bater linha a
 * linha com o banco, nada é apagado. Ficam de fora `settings` (chave do 2Captcha, ritmo) e
 * `schema_migrations`; os XMLs/HTMLs em disco também ficam.
 */
export async function limparBanco(): Promise<{ dir: string; tabelas: number; linhas: number }> {
  if (limpando) throw new Error('limpeza já em andamento');
  limpando = true;
  try {
    coletor.parar();
    const { rows } = await pool.query<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`,
    );
    const tabelas = rows.map((r) => r.t).filter((t) => !FORA.has(t));
    const stamp = new Date().toLocaleString('sv-SE', { timeZone: config.tz }).replace(/[: ]/g, '-');
    const dir = path.join(paths.exports(), `antes-de-limpar-${stamp}`);
    const copia = await exportarParquet(dir);
    const exportadas = new Map(copia.tabelas.map((t) => [t.tabela, t.linhas]));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Confere dentro da transação, já com as tabelas travadas, para não apagar o que a cópia não viu.
      await client.query(`LOCK TABLE ${tabelas.map((t) => `"${t}"`).join(', ')} IN ACCESS EXCLUSIVE MODE`);
      let linhas = 0;
      for (const t of tabelas) {
        const n = Number((await client.query(`SELECT count(*) FROM "${t}"`)).rows[0].count);
        if (exportadas.get(t) !== n) throw new Error(`a cópia de "${t}" tem ${exportadas.get(t) ?? 0} linha(s) e o banco ${n}; nada foi apagado`);
        linhas += n;
      }
      await client.query(`TRUNCATE ${tabelas.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
      await client.query('COMMIT');
      return { dir, tabelas: tabelas.length, linhas };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } finally {
    limpando = false;
  }
}
