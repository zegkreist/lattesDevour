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
