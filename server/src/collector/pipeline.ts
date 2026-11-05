import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../db.js';
import { config, paths } from '../config.js';
import { enfileirarVinculados } from '../discovery/ids.js';
import { parseCV, parseHtmlCV, HTML_PARSER } from '../parsers/index.js';
import { ingest } from '../store/ingest.js';
import { decodeXml } from '../util/xmlfile.js';

export function xmlPathFor(id: string): string {
  return path.join(paths.xml(), `${id}.xml`);
}

export function htmlPathFor(id: string): string {
  return path.join(paths.html(), `${id}.html`);
}

/** Guarda o HTML do CV (página pública) e marca a fila como 'html' até existir parser de HTML. */
export async function saveHtml(id: string, html: string, caminho: 'cv' | 'previa' = 'cv'): Promise<string> {
  fs.mkdirSync(paths.html(), { recursive: true });
  const file = htmlPathFor(id);
  fs.writeFileSync(file + '.tmp', html);
  fs.renameSync(file + '.tmp', file);
  await pool.query(
    `UPDATE fila SET status='html', html_path=$2, caminho=$3, ultimo_erro=NULL, atualizado_em=now() WHERE lattes_id=$1`,
    [id, file, caminho],
  );
  return file;
}

export async function parseOne(id: string): Promise<{ ok: boolean; erro?: string }> {
  try {
    // XML é mais completo; sem ele, o HTML da página do CV.
    const xml = xmlPathFor(id);
    const temXml = fs.existsSync(xml);
    const buf = fs.readFileSync(temXml ? xml : htmlPathFor(id));
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const { cv, parser, versao } = temXml
      ? parseCV(decodeXml(buf))
      : { cv: parseHtmlCV(buf.toString('utf8')), ...HTML_PARSER };
    if (cv.lattesId !== id) throw new Error(`CV é do ID ${cv.lattesId}, esperado ${id}`);
    await ingest(cv, { parser, versao, xmlSha256: sha });
    // Rede pedida no painel: propaga uma vez e zera (reprocessar depois não repropaga). Sem rede, os
    // citados não entram na fila.
    const rede = Number((await pool.query(`UPDATE fila f SET rede = 0 FROM (SELECT rede FROM fila WHERE lattes_id = $1) a
      WHERE f.lattes_id = $1 RETURNING a.rede`, [id])).rows[0]?.rede ?? 0);
    if (cv.vinculados?.length) await enfileirarVinculados(cv.vinculados, rede);
    return { ok: true };
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    await pool.query(`UPDATE fila SET status='erro', ultimo_erro=$2, atualizado_em=now() WHERE lattes_id=$1`, [id, `parse: ${erro}`.slice(0, 500)]);
    return { ok: false, erro };
  }
}

let parsing = false;
/**
 * Processa o que está 'baixado' (XML) ou 'html', com config.parseConcorrencia CVs ao mesmo tempo
 * (o trabalho é quase todo espera do banco). Roda em loop curto; reentrância bloqueada.
 */
export async function parsePending(limit = 200): Promise<number> {
  if (parsing) return 0;
  parsing = true;
  try {
    const { rows } = await pool.query(`SELECT lattes_id FROM fila WHERE status IN ('baixado','html') ORDER BY atualizado_em LIMIT $1`, [limit]);
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(config.parseConcorrencia, rows.length) }, async () => {
        while (i < rows.length) await parseOne(rows[i++].lattes_id);
      }),
    );
    return rows.length;
  } finally {
    parsing = false;
  }
}

/**
 * Reprocessa todo XML/HTML em disco, inclusive arquivos soltos em data/xml e data/html (ex.: HTML
 * salvo à mão do navegador). Cada CV troca só o que ele mesmo declarou (ver store/ingest.ts):
 * nada é apagado em massa e o painel segue completo durante o reprocesso. É por isso que
 * guardamos o arquivo cru. CV que o coletor está baixando agora é processado quando terminar.
 * CV importado (parseado, sem caminho) fica de fora: um arquivo em disco seria a versão que perdeu.
 */
export async function reprocessar(): Promise<number> {
  const emDisco = (dir: string, ext: string) =>
    fs.existsSync(dir) ? fs.readdirSync(dir).flatMap((f) => new RegExp(`^(\\d{16})\\.${ext}$`).exec(f)?.[1] ?? []) : [];
  const naoImportado = `WHERE NOT (fila.origem = 'importado' AND fila.status = 'parseado' AND fila.xml_path IS NULL AND fila.html_path IS NULL)`;
  await pool.query(
    `INSERT INTO fila (lattes_id, status, origem, xml_path)
     SELECT x, 'baixado', 'import', $2 || '/' || x || '.xml' FROM unnest($1::text[]) x
     ON CONFLICT (lattes_id) DO UPDATE SET xml_path = EXCLUDED.xml_path ${naoImportado}`,
    [emDisco(paths.xml(), 'xml'), paths.xml()],
  );
  await pool.query(
    `INSERT INTO fila (lattes_id, status, origem, html_path)
     SELECT x, 'html', 'import', $2 || '/' || x || '.html' FROM unnest($1::text[]) x
     ON CONFLICT (lattes_id) DO UPDATE SET html_path = EXCLUDED.html_path ${naoImportado}`,
    [emDisco(paths.html(), 'html'), paths.html()],
  );
  const r = await pool.query(
    `UPDATE fila SET status = CASE WHEN xml_path IS NOT NULL THEN 'baixado' ELSE 'html' END, ultimo_erro = NULL, atualizado_em = now()
     WHERE (xml_path IS NOT NULL OR html_path IS NOT NULL) AND status NOT IN ('baixando', 'aguardando_captcha')`,
  );
  return r.rowCount ?? 0;
}
