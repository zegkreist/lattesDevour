import { registerParser } from './engine.js';
import { lattesV1 } from './lattes-v1/index.js';

// Para suportar um formato novo do Lattes: crie parsers/lattes-v2/ com um CVParser e
// registre-o aqui. Os XMLs já baixados podem ser reprocessados pelo painel ("Reprocessar").
registerParser(lattesV1);

export { parseCV, currentParserVersion } from './engine.js';
export { parseHtmlCV } from './lattes-html-v1/index.js';
import { listParsers as parsersXml } from './engine.js';
import { PARSER_ID, PARSER_VERSAO } from './lattes-html-v1/index.js';
export const HTML_PARSER = { parser: PARSER_ID, versao: PARSER_VERSAO };

/** Parsers de XML (registro) + o de HTML (página do CV). */
export const listParsers = () => [...parsersXml(), { id: PARSER_ID, versao: PARSER_VERSAO }];
export type { ParsedCV } from './types.js';
