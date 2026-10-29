import { unzipSync } from 'fflate';

// O XML do Lattes é ISO-8859-1 (declarado no prólogo); o download vem num .zip.
export function decodeXml(buf: Uint8Array): string {
  const head = Buffer.from(buf.subarray(0, 200)).toString('latin1');
  const enc = /encoding=["']([^"']+)["']/i.exec(head)?.[1]?.toLowerCase() ?? 'utf-8';
  return new TextDecoder(enc === 'iso-8859-1' ? 'windows-1252' : enc).decode(buf);
}

export function isZip(buf: Uint8Array): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

// Devolve o primeiro .xml de dentro do zip (ou o próprio buffer se já for XML).
export function extractXml(buf: Uint8Array): Uint8Array {
  if (!isZip(buf)) return buf;
  const files = unzipSync(buf);
  const name = Object.keys(files).find((n) => n.toLowerCase().endsWith('.xml'));
  if (!name) throw new Error('zip sem arquivo .xml');
  return files[name];
}
