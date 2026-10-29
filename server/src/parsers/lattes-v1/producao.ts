import { norm, toInt } from '../../util/text.js';
import { areasDoConhecimento, arr, attrs, autores, children, firstAttr, palavrasChave } from '../helpers.js';
import type { Node, ParseContext, ParsedObra, SectionParser } from '../types.js';

// Nome do elemento-item -> tipo canônico. Itens que não estão aqui ainda são extraídos
// (o tipo vira o nome do elemento em snake_case): é o que absorve tipos novos sem código.
export const TIPO_POR_ITEM: Record<string, string> = {
  'ARTIGO-PUBLICADO': 'artigo',
  'ARTIGO-ACEITO-PARA-PUBLICACAO': 'artigo_aceito',
  'TRABALHO-EM-EVENTOS': 'evento',
  'LIVRO-PUBLICADO-OU-ORGANIZADO': 'livro',
  'CAPITULO-DE-LIVRO-PUBLICADO': 'capitulo',
  'TEXTO-EM-JORNAL-OU-REVISTA': 'texto_jornal',
  SOFTWARE: 'software',
  PATENTE: 'patente',
  'TRABALHO-TECNICO': 'trabalho_tecnico',
  'PRODUTO-TECNOLOGICO': 'produto_tecnologico',
  'PROCESSOS-OU-TECNICAS': 'processo_tecnica',
  'DEMAIS-TRABALHOS': 'demais_trabalhos',
};

const VEICULO_ATTRS = [
  'TITULO-DO-PERIODICO-OU-REVISTA',
  'NOME-DO-EVENTO',
  'TITULO-DO-JORNAL-OU-REVISTA',
  'TITULO-DOS-ANAIS-OU-PROCEEDINGS',
  'TITULO-DO-LIVRO',
  'NOME-DA-EDITORA',
];

/** Item de produção = elemento com algum filho DADOS-BASICOS-*. Convenção do XSD do Lattes. */
export function isItem(n: Node): boolean {
  return Object.keys(n).some((k) => k.startsWith('DADOS-BASICOS-'));
}

export function parseItem(itemName: string, item: Node): ParsedObra | null {
  const basicosKey = Object.keys(item).find((k) => k.startsWith('DADOS-BASICOS-'));
  if (!basicosKey) return null;
  const b = attrs(arr(item[basicosKey])[0]);
  const detKey = Object.keys(item).find((k) => k.startsWith('DETALHAMENTO-'));
  const d = detKey ? attrs(arr(item[detKey])[0]) : {};

  const titulo = firstAttr(b, (k) => k.startsWith('TITULO') && !k.endsWith('INGLES'));
  if (!titulo) return null;
  const ano = toInt(firstAttr(b, (k) => k.startsWith('ANO')));
  const tipo = TIPO_POR_ITEM[itemName] ?? itemName.toLowerCase().replace(/-/g, '_');
  const doi = b['DOI'] ? b['DOI'].replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase() : null;
  const veiculo = VEICULO_ATTRS.map((k) => d[k]).find(Boolean) ?? null;
  const { grandes, areas } = areasDoConhecimento(item);

  const tn = norm(titulo);
  return {
    chave: doi ? `doi:${doi}` : `${tipo}|${tn}|${ano ?? ''}`,
    tipo,
    subtipo: b['NATUREZA'] ?? b['TIPO'] ?? null,
    titulo,
    ano,
    doi,
    idioma: b['IDIOMA'] ?? null,
    veiculo,
    issn: d['ISSN'] ?? null,
    isbn: d['ISBN'] ?? null,
    pais: firstAttr(b, (k) => k.startsWith('PAIS')),
    palavrasChave: palavrasChave(item),
    grandesAreas: grandes,
    areas,
    autores: autores(item),
    dados: { ...d, ...Object.fromEntries(Object.entries(b).filter(([k]) => !k.startsWith('TITULO'))) },
  };
}

/** Desce a árvore até os itens; devolve caminhos que não renderam nada. */
export function collect(node: Node, path: string, ctx: ParseContext, depth = 0): void {
  for (const [name, child] of children(node)) {
    const here = `${path}/${name}`;
    if (isItem(child)) {
      const o = parseItem(name, child);
      if (o) ctx.cv.obras.push(o);
      else ctx.warn(`item sem título em ${here}`);
    } else if (depth < 4 && children(child).length > 0) {
      collect(child, here, ctx, depth + 1);
    } else if (Object.keys(child).length > 0) {
      // Folha com atributos que não é um item de produção: formato que não conhecemos.
      ctx.cv.desconhecidos.push(here);
    }
  }
}

function section(name: string, element: string): SectionParser {
  return { name, element, parse: (node, ctx) => collect(node, element, ctx) };
}

export const producaoBibliografica = section('producao-bibliografica', 'PRODUCAO-BIBLIOGRAFICA');
export const producaoTecnica = section('producao-tecnica', 'PRODUCAO-TECNICA');
