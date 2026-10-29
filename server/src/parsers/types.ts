export type Node = Record<string, any>;

export interface ParsedAutor {
  ordem: number;
  nome: string;
  nomeCitacao: string | null;
  lattesId: string | null;
}

export interface ParsedObra {
  chave: string;
  tipo: string;
  subtipo: string | null;
  titulo: string;
  ano: number | null;
  doi: string | null;
  idioma: string | null;
  veiculo: string | null;
  issn: string | null;
  isbn: string | null;
  pais: string | null;
  palavrasChave: string[];
  grandesAreas: string[];
  areas: string[];
  autores: ParsedAutor[];
  dados: Record<string, string>;
}

export interface ParsedOrientacao {
  nivel: 'mestrado' | 'doutorado' | 'pos_doutorado' | 'outras';
  orientadoNome: string;
  orientadoLattesId: string | null;
  titulo: string | null;
  ano: number | null;
  instituicao: string | null;
  curso: string | null;
}

export interface ParsedCV {
  lattesId: string;
  nome: string;
  nomesCitacao: string[];
  orcid: string | null;
  resumo: string | null;
  dataAtualizacao: string | null; // YYYY-MM-DD
  instituicao: { codigo: string | null; nome: string; uf: string | null; cidade: string | null; pais: string | null } | null;
  grandesAreas: string[];
  areas: string[];
  formacao: Record<string, unknown>[];
  atuacoes: Record<string, unknown>[];
  obras: ParsedObra[];
  orientacoes: ParsedOrientacao[];
  /** Caminhos de elementos que nenhum parser soube extrair (sinal de formato novo). */
  desconhecidos: string[];
  avisos: string[];
}

export interface ParseContext {
  cv: ParsedCV;
  warn(msg: string): void;
}

/** Extrai uma seção do CV (um filho direto de CURRICULO-VITAE ou de DADOS-GERAIS). */
export interface SectionParser {
  name: string;
  /** Nome do elemento que esta seção trata. */
  element: string;
  parse(node: Node, ctx: ParseContext): void;
}

/** Um parser de formato de CV inteiro. Formato novo = novo CVParser registrado. */
export interface CVParser {
  id: string;
  versao: number;
  matches(root: Node): boolean;
  parse(root: Node): ParsedCV;
}
