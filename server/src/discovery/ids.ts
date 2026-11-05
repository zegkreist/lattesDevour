import { pool } from '../db.js';

/** Extrai todo ID Lattes (16 dígitos) de um texto qualquer: lista do CNPq, URLs, CSV. */
export function extrairIds(texto: string): string[] {
  return Array.from(new Set(texto.match(/(?<!\d)\d{16}(?!\d)/g) ?? []));
}

/** Prioridade na fila: pedido manual no painel > rede de um pedido manual > o resto. */
export const PRIORIDADE = { manual: 2, rede: 1, normal: 0 };

/**
 * Pesquisadores citados com ID num CV coletado. Só entram na fila dentro da rede pedida no painel
 * (rede > 0): com prioridade, levando rede - 1 níveis adiante; quem já foi coletado e precisa
 * propagar mais um nível volta para o parse (sem captcha). Fora da rede (rede = 0) nada entra,
 * senão cada CV novo puxaria os vizinhos dele e a fila cresceria sem parar.
 */
export async function enfileirarVinculados(vs: { lattesId: string; nome: string | null }[], rede = 0): Promise<number> {
  if (rede <= 0 || !vs.length) return 0;
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
    [vs.map((v) => v.lattesId), vs.map((v) => v.nome), PRIORIDADE.rede, rede - 1],
  );
  return r.rowCount ?? 0;
}

export async function enfileirar(ids: string[], origem: string): Promise<number> {
  let novos = 0;
  for (let i = 0; i < ids.length; i += 5000) {
    const r = await pool.query(
      `INSERT INTO fila (lattes_id, origem)
       SELECT x, $2 FROM unnest($1::text[]) x ON CONFLICT (lattes_id) DO NOTHING`,
      [ids.slice(i, i + 5000), origem],
    );
    novos += r.rowCount ?? 0;
  }
  return novos;
}
