import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

const here = path.dirname(fileURLToPath(import.meta.url));

export async function migrate(dir = path.resolve(here, '../migrations')): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (nome text PRIMARY KEY, em timestamptz NOT NULL DEFAULT now())`,
  );
  const done = new Set((await pool.query('SELECT nome FROM schema_migrations')).rows.map((r) => r.nome));
  const applied: string[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await client.query('INSERT INTO schema_migrations (nome) VALUES ($1)', [f]);
      await client.query('COMMIT');
      applied.push(f);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  return applied;
}

export async function getSetting<T>(chave: string, fallback: T): Promise<T> {
  const r = await pool.query('SELECT valor FROM settings WHERE chave = $1', [chave]);
  return r.rows[0] ? (r.rows[0].valor as T) : fallback;
}

export async function setSetting(chave: string, valor: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO settings (chave, valor) VALUES ($1, $2)
     ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`,
    [chave, JSON.stringify(valor)],
  );
}
