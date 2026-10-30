const REGIOES: Record<string, string[]> = {
  norte: ['AC', 'AP', 'AM', 'PA', 'RO', 'RR', 'TO'],
  nordeste: ['AL', 'BA', 'CE', 'MA', 'PB', 'PE', 'PI', 'RN', 'SE'],
  'centro-oeste': ['DF', 'GO', 'MT', 'MS'],
  sudeste: ['ES', 'MG', 'RJ', 'SP'],
  sul: ['PR', 'RS', 'SC'],
};

const UF_TO_REGIAO = new Map<string, string>();
for (const [regiao, ufs] of Object.entries(REGIOES)) for (const uf of ufs) UF_TO_REGIAO.set(uf, regiao);

export function regiaoDaUf(uf: string | null | undefined): string | null {
  return uf ? (UF_TO_REGIAO.get(uf.trim().toUpperCase()) ?? null) : null;
}

export const TODAS_UFS = Array.from(UF_TO_REGIAO.keys()).sort();

// ───────────── UF a partir do nome da instituição ─────────────
// Para quem não publica endereço profissional: "Universidade Federal de Goiás" -> GO,
// "USP - Escola de Artes" -> SP, "PUC-SP" -> SP. Só regras seguras; sem acerto, null.

// Estado citado no nome ("de Goiás", "do Estado do Rio de Janeiro"). Mais longos primeiro.
const ESTADOS: [string, string][] = [
  ['rio grande do norte', 'RN'], ['rio grande do sul', 'RS'], ['mato grosso do sul', 'MS'], ['mato grosso', 'MT'],
  ['rio de janeiro', 'RJ'], ['espirito santo', 'ES'], ['minas gerais', 'MG'], ['sao paulo', 'SP'],
  ['santa catarina', 'SC'], ['distrito federal', 'DF'], ['brasilia', 'DF'], ['parana', 'PR'], ['para', 'PA'],
  ['goias', 'GO'], ['bahia', 'BA'], ['pernambuco', 'PE'], ['ceara', 'CE'], ['maranhao', 'MA'], ['piaui', 'PI'],
  ['paraiba', 'PB'], ['alagoas', 'AL'], ['sergipe', 'SE'], ['tocantins', 'TO'], ['amazonas', 'AM'], ['acre', 'AC'],
  ['amapa', 'AP'], ['roraima', 'RR'], ['rondonia', 'RO'],
];
const ESTADO_RE = ESTADOS.map(([nome, uf]) => [new RegExp(`\\b(?:de|do|da|dos)\\s+(?:estado\\s+d[eoa]\\s+)?${nome}\\b`), uf] as const);

// Siglas de instituições sem o estado no nome (ou em que a sigla aparece sozinha).
const SIGLAS: Record<string, string> = {
  USP: 'SP', UNICAMP: 'SP', UNESP: 'SP', UNIFESP: 'SP', UFSCAR: 'SP', UFABC: 'SP', ITA: 'SP',
  UFMG: 'MG', UFJF: 'MG', UFU: 'MG', UFV: 'MG', UFOP: 'MG', UFLA: 'MG', UNIFAL: 'MG', UFSJ: 'MG', UFVJM: 'MG', UFTM: 'MG',
  UFRJ: 'RJ', UFF: 'RJ', UERJ: 'RJ', UNIRIO: 'RJ', UFRRJ: 'RJ', FIOCRUZ: 'RJ', 'PUC-RIO': 'RJ', UENF: 'RJ',
  UNB: 'DF', UFG: 'GO', UFCAT: 'GO', UFJ: 'GO', UEG: 'GO', IFG: 'GO', IFGOIANO: 'GO',
  UFRGS: 'RS', UFSM: 'RS', UFPEL: 'RS', PUCRS: 'RS', FURG: 'RS', UNISINOS: 'RS', UFSC: 'SC', UDESC: 'SC',
  UFPR: 'PR', UTFPR: 'PR', UEL: 'PR', UEM: 'PR', UEPG: 'PR', UNIOESTE: 'PR',
  UFPE: 'PE', UFRPE: 'PE', UPE: 'PE', UFBA: 'BA', UNEB: 'BA', UEFS: 'BA', UESC: 'BA', UFRB: 'BA',
  UFC: 'CE', UECE: 'CE', UFPA: 'PA', UFOPA: 'PA', UNIFESSPA: 'PA', UFRA: 'PA', UFAM: 'AM', UEA: 'AM',
  UFRN: 'RN', UFERSA: 'RN', UFPB: 'PB', UFCG: 'PB', UEPB: 'PB', UFAL: 'AL', UFS: 'SE', UFMA: 'MA', UEMA: 'MA',
  UFPI: 'PI', UESPI: 'PI', UFMT: 'MT', UNEMAT: 'MT', UFMS: 'MS', UFGD: 'MS', UEMS: 'MS', UFES: 'ES',
  UFT: 'TO', UFRR: 'RR', UNIFAP: 'AP', UFAC: 'AC', UNIR: 'RO',
};

export function ufPeloNome(nome: string | null | undefined): string | null {
  if (!nome) return null;
  // Sufixo de UF: "PUC-SP", "Faculdade X/GO", "Instituto Y (RJ)".
  const suf = /[-/(]\s*([A-Z]{2})\)?\s*$/.exec(nome.trim())?.[1];
  if (suf && UF_TO_REGIAO.has(suf)) return suf;
  for (const tok of nome.split(/[^\p{L}\d-]+/u)) {
    // "PUC-RIO" inteiro, ou "UFG-Regional" pelas partes.
    for (const t of [tok, ...tok.split('-')]) {
      const uf = SIGLAS[t.toUpperCase()];
      if (uf) return uf;
    }
  }
  const n = nome.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  return ESTADO_RE.find(([re]) => re.test(n))?.[1] ?? null;
}

/**
 * Primeira instituição candidata com UF: a já conhecida no banco (aprendida do endereço de
 * algum CV) ou a deduzida do nome. Os candidatos vêm em ordem de preferência.
 */
export function escolherUf(candidatos: string[], conhecidas: Map<string, string>, normalizar: (s: string) => string): { uf: string; instituicao: string } | null {
  for (const inst of candidatos) {
    const uf = conhecidas.get(normalizar(inst)) ?? ufPeloNome(inst);
    if (uf) return { uf, instituicao: inst };
  }
  return null;
}
