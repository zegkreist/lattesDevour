import { pool } from '../db.js';

/** Extrai todo ID Lattes (16 dígitos) de um texto qualquer: lista do CNPq, URLs, CSV. */
export function extrairIds(texto: string): string[] {
  return Array.from(new Set(texto.match(/(?<!\d)\d{16}(?!\d)/g) ?? []));
}

/** Prioridade na fila: pedido manual no painel > rede de um pedido manual > o resto. */
export const PRIORIDADE = { manual: 2, rede: 1, normal: 0 };

/**
 * Pesquisadores citados com ID num CV coletado: entram na fila com o nome como dica.
 * Com rede > 0 (o CV veio de "priorizar a rede"), entram com prioridade e levam rede - 1 níveis
 * adiante; quem já foi coletado e precisa propagar mais um nível volta para o parse (sem captcha).
 */
export async function enfileirarVinculados(vs: { lattesId: string; nome: string | null }[], rede = 0): Promise<number> {
  const prio = rede > 0 ? PRIORIDADE.rede : PRIORIDADE.normal;
  const r = await pool.query(
    `INSERT INTO fila (lattes_id, origem, nome_hint, prioridade, rede)
     SELECT x.id, 'cv', x.nome, $3, $4 FROM unnest($1::text[], $2::text[]) AS x(id, nome)
     ON CONFLICT (lattes_id) DO UPDATE SET
       nome_hint = COALESCE(fila.nome_hint, EXCLUDED.nome_hint),
       prioridade = GREATEST(fila.prioridade, EXCLUDED.prioridade),
       rede = GREATEST(fila.rede, EXCLUDED.rede),
       status = CASE WHEN EXCLUDED.rede > fila.rede AND fila.status = 'parseado' AND (fila.xml_path IS NOT NULL OR fila.html_path IS NOT NULL)
                     THEN CASE WHEN fila.xml_path IS NOT NULL THEN 'baixado' ELSE 'html' END ELSE fila.status END
     WHERE (fila.nome_hint IS NULL AND EXCLUDED.nome_hint IS NOT NULL) OR EXCLUDED.prioridade > fila.prioridade OR EXCLUDED.rede > fila.rede`,
    [vs.map((v) => v.lattesId), vs.map((v) => v.nome), prio, Math.max(rede - 1, 0)],
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
