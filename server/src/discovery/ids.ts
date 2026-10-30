import { pool } from '../db.js';

/** Extrai todo ID Lattes (16 dígitos) de um texto qualquer: lista do CNPq, URLs, CSV. */
export function extrairIds(texto: string): string[] {
  return Array.from(new Set(texto.match(/(?<!\d)\d{16}(?!\d)/g) ?? []));
}

/** Pesquisadores citados com ID num CV coletado: entram na fila com o nome como dica. */
export async function enfileirarVinculados(vs: { lattesId: string; nome: string | null }[]): Promise<number> {
  const r = await pool.query(
    `INSERT INTO fila (lattes_id, origem, nome_hint)
     SELECT x.id, 'cv', x.nome FROM unnest($1::text[], $2::text[]) AS x(id, nome)
     ON CONFLICT (lattes_id) DO UPDATE SET nome_hint = COALESCE(fila.nome_hint, EXCLUDED.nome_hint)
     WHERE fila.nome_hint IS NULL AND EXCLUDED.nome_hint IS NOT NULL`,
    [vs.map((v) => v.lattesId), vs.map((v) => v.nome)],
  );
  return r.rowCount ?? 0;
}

export async function enfileirar(ids: string[], origem: string, alvoId?: number | null): Promise<number> {
  let novos = 0;
  for (let i = 0; i < ids.length; i += 5000) {
    const r = await pool.query(
      `INSERT INTO fila (lattes_id, origem, instituicao_alvo_id)
       SELECT x, $2, $3 FROM unnest($1::text[]) x ON CONFLICT (lattes_id) DO NOTHING`,
      [ids.slice(i, i + 5000), origem, alvoId ?? null],
    );
    novos += r.rowCount ?? 0;
  }
  return novos;
}
