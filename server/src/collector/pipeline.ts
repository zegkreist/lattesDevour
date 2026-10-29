import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../db.js';
import { paths } from '../config.js';
import { currentParserVersion, parseCV } from '../parsers/index.js';
import { ingest } from '../store/ingest.js';
import { unzipSync } from 'fflate';
import { decodeXml, extractXml, isZip } from '../util/xmlfile.js';

export function xmlPathFor(id: string): string {
  return path.join(paths.xml(), `${id}.xml`);
}

/** Guarda o XML cru (no encoding original) em disco e marca a fila como baixado. */
export async function saveXml(id: string, bytes: Uint8Array, origem = 'manual'): Promise<string> {
  fs.mkdirSync(paths.xml(), { recursive: true });
  const file = xmlPathFor(id);
  fs.writeFileSync(file + '.tmp', bytes);
  fs.renameSync(file + '.tmp', file);
  await pool.query(
    `INSERT INTO fila (lattes_id, status, origem, xml_path) VALUES ($1,'baixado',$2,$3)
     ON CONFLICT (lattes_id) DO UPDATE SET status='baixado', xml_path=$3, ultimo_erro=NULL, atualizado_em=now()`,
    [id, origem, file],
  );
  return file;
}

export async function parseOne(id: string): Promise<{ ok: boolean; erro?: string }> {
  try {
    const file = xmlPathFor(id);
    const buf = fs.readFileSync(file);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const { cv, parser, versao } = parseCV(decodeXml(buf));
    if (cv.lattesId !== id) throw new Error(`XML é do ID ${cv.lattesId}, esperado ${id}`);
    await ingest(cv, { parser, versao, xmlSha256: sha });
    return { ok: true };
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    await pool.query(`UPDATE fila SET status='erro', ultimo_erro=$2, atualizado_em=now() WHERE lattes_id=$1`, [id, `parse: ${erro}`.slice(0, 500)]);
    return { ok: false, erro };
  }
}

let parsing = false;
/** Processa o que está 'baixado'. Roda em loop curto; reentrância bloqueada. */
export async function parsePending(limit = 50): Promise<number> {
  if (parsing) return 0;
  parsing = true;
  try {
    const { rows } = await pool.query(`SELECT lattes_id FROM fila WHERE status='baixado' ORDER BY atualizado_em LIMIT $1`, [limit]);
    for (const r of rows) await parseOne(r.lattes_id);
    return rows.length;
  } finally {
    parsing = false;
  }
}

/** Reprocessa XMLs já em disco: só os de parser antigo, ou todos. É por isso que guardamos o XML cru. */
export async function reprocessar(todos: boolean): Promise<number> {
  const r = await pool.query(
    `UPDATE fila SET status='baixado', atualizado_em=now()
     WHERE xml_path IS NOT NULL AND status IN ('parseado','erro')
       AND ($1 OR lattes_id IN (SELECT id FROM pesquisador WHERE parser_versao < $2)
            OR lattes_id NOT IN (SELECT id FROM pesquisador))`,
    [todos, currentParserVersion()],
  );
  return r.rowCount ?? 0;
}

const ID_RE = /NUMERO-IDENTIFICADOR="(\d{16})"/;

/** Varre data/import: .xml ou .zip (um ou vários XMLs) -> data/xml + fila. Formato do Extrator do CNPq. */
export async function importarPasta(): Promise<{ importados: number; falhas: string[] }> {
  const dir = paths.imports();
  fs.mkdirSync(path.join(dir, 'processados'), { recursive: true });
  let importados = 0;
  const falhas: string[] = [];
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (!fs.statSync(full).isFile() || !/\.(xml|zip)$/i.test(f)) continue;
    try {
      const raw = fs.readFileSync(full);
      for (const xml of extraiTodos(raw)) {
        const id = ID_RE.exec(Buffer.from(xml.subarray(0, 4096)).toString('latin1'))?.[1];
        if (!id) throw new Error('XML sem NUMERO-IDENTIFICADOR');
        await saveXml(id, xml, 'import');
        importados++;
      }
      fs.renameSync(full, path.join(dir, 'processados', `${Date.now()}-${f}`));
    } catch (e) {
      falhas.push(`${f}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { importados, falhas };
}

function extraiTodos(buf: Uint8Array): Uint8Array[] {
  if (!isZip(buf)) return [buf];
  const files = unzipSync(buf);
  const xmls = Object.entries(files).filter(([n]) => n.toLowerCase().endsWith('.xml')).map(([, b]) => b);
  if (!xmls.length) throw new Error('zip sem .xml');
  return xmls;
}
export { extractXml };
