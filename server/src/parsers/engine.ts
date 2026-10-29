import { XMLParser } from 'fast-xml-parser';
import type { CVParser, Node, ParsedCV } from './types.js';

// Registro de parsers de formato. A ordem de registro é a ordem de tentativa: o primeiro
// cujo matches() aceita a raiz faz o parse. Para suportar um formato novo do Lattes,
// crie um CVParser e chame registerParser() em parsers/index.ts. Nada mais muda.
const registry: CVParser[] = [];

export function registerParser(p: CVParser): void {
  if (registry.some((r) => r.id === p.id)) throw new Error(`parser duplicado: ${p.id}`);
  registry.push(p);
}

export function listParsers(): { id: string; versao: number }[] {
  return registry.map((p) => ({ id: p.id, versao: p.versao }));
}

/** Maior versão entre os parsers: pesquisadores com parser_versao menor podem ser reprocessados. */
export function currentParserVersion(): number {
  return registry.reduce((m, p) => Math.max(m, p.versao), 0);
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
});

export interface ParseResult {
  cv: ParsedCV;
  parser: string;
  versao: number;
}

export function parseCV(xmlText: string): ParseResult {
  const doc = xml.parse(xmlText) as Node;
  const root = doc['CURRICULO-VITAE'] as Node | undefined;
  if (!root) throw new Error('XML sem elemento CURRICULO-VITAE');
  for (const p of registry) {
    if (p.matches(root)) return { cv: p.parse(root), parser: p.id, versao: p.versao };
  }
  throw new Error(`nenhum parser reconhece este CV (parsers: ${registry.map((r) => r.id).join(', ')})`);
}
