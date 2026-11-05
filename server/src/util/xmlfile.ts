// O XML do Lattes é ISO-8859-1 (declarado no prólogo).
export function decodeXml(buf: Uint8Array): string {
  const head = Buffer.from(buf.subarray(0, 200)).toString('latin1');
  const enc = /encoding=["']([^"']+)["']/i.exec(head)?.[1]?.toLowerCase() ?? 'utf-8';
  return new TextDecoder(enc === 'iso-8859-1' ? 'windows-1252' : enc).decode(buf);
}
