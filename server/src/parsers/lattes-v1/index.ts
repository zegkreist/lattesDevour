import { attr } from '../helpers.js';
import type { CVParser, Node, ParseContext, ParsedCV, SectionParser } from '../types.js';
import { dadosGerais } from './dadosGerais.js';
import { outraProducao } from './outraProducao.js';
import { producaoBibliografica, producaoTecnica } from './producao.js';

// Seções de CURRICULO-VITAE que este parser extrai. Para tratar uma seção nova, escreva um
// SectionParser e some aqui. Seções conhecidas mas deliberadamente ignoradas ficam em IGNORADAS
// para não poluirem o relatório de "desconhecidos".
const SECOES: SectionParser[] = [dadosGerais, producaoBibliografica, producaoTecnica, outraProducao];
const IGNORADAS = new Set(['DADOS-COMPLEMENTARES']);

export const lattesV1: CVParser = {
  id: 'lattes-xml-v1',
  versao: 1,
  matches: (root: Node) => !!root['DADOS-GERAIS'] && !!attr(root, 'NUMERO-IDENTIFICADOR'),
  parse(root: Node): ParsedCV {
    const cv: ParsedCV = {
      lattesId: attr(root, 'NUMERO-IDENTIFICADOR') ?? '',
      nome: '',
      nomesCitacao: [],
      orcid: null,
      resumo: null,
      dataAtualizacao: null,
      instituicao: null,
      grandesAreas: [],
      areas: [],
      formacao: [],
      atuacoes: [],
      obras: [],
      orientacoes: [],
      desconhecidos: [],
      avisos: [],
    };
    const ctx: ParseContext = { cv, warn: (m) => cv.avisos.push(m) };

    const d = attr(root, 'DATA-ATUALIZACAO'); // DDMMAAAA
    if (d && /^\d{8}$/.test(d)) cv.dataAtualizacao = `${d.slice(4)}-${d.slice(2, 4)}-${d.slice(0, 2)}`;

    const porElemento = new Map(SECOES.map((s) => [s.element, s]));
    for (const key of Object.keys(root)) {
      if (key.startsWith('@_') || key.startsWith('#') || key.startsWith('?')) continue;
      const sec = porElemento.get(key);
      if (sec) {
        const node = Array.isArray(root[key]) ? root[key][0] : root[key];
        sec.parse((node ?? {}) as Node, ctx);
      } else if (!IGNORADAS.has(key)) {
        cv.desconhecidos.push(key);
      }
    }
    cv.grandesAreas = [...new Set([...cv.grandesAreas, ...cv.obras.flatMap((o) => o.grandesAreas)])];
    cv.areas = [...new Set([...cv.areas, ...cv.obras.flatMap((o) => o.areas)])];
    if (!/^\d{16}$/.test(cv.lattesId)) throw new Error(`NUMERO-IDENTIFICADOR inválido: "${cv.lattesId}"`);
    if (!cv.nome) throw new Error('CV sem NOME-COMPLETO');
    return cv;
  },
};
