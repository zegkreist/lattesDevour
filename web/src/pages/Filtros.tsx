import { usePoll } from '../api';

export interface Filtro { q: string; uf: string; regiao: string; tema: string; inst: string; tipo: string; kw: string; ano_de: string; ano_ate: string }
export const FILTRO_VAZIO: Filtro = { q: '', uf: '', regiao: '', tema: '', inst: '', tipo: '', kw: '', ano_de: '', ano_ate: '' };

export function Filtros({ f, set, mostrar }: { f: Filtro; set: (f: Filtro) => void; mostrar: (keyof Filtro)[] }) {
  const { data } = usePoll<any>('/facets');
  const up = (k: keyof Filtro) => (e: { target: { value: string } }) => set({ ...f, [k]: e.target.value });
  const sel = (k: keyof Filtro, rotulo: string, itens: { v: string; n: string }[] = []) => mostrar.includes(k) && (
    <select value={f[k]} onChange={up(k)} title={rotulo}>
      <option value="">{rotulo}</option>{itens.map((i) => <option key={i.v} value={i.v}>{i.v} ({i.n})</option>)}
    </select>
  );
  return (
    <div className="row">
      {mostrar.includes('q') && <input placeholder="Texto / nome / título" value={f.q} onChange={up('q')} style={{ minWidth: 240 }} />}
      {sel('regiao', 'Região', data?.regioes)}{sel('uf', 'UF', data?.ufs)}{sel('inst', 'Instituição', data?.instituicoes)}
      {sel('tema', 'Tema (grande área)', data?.temas)}{sel('tipo', 'Tipo de obra', data?.tipos)}
      {mostrar.includes('kw') && <input placeholder="Palavra-chave" value={f.kw} onChange={up('kw')} style={{ width: 150 }} />}
      {mostrar.includes('ano_de') && <><input placeholder="Ano de" value={f.ano_de} onChange={up('ano_de')} style={{ width: 80 }} /><input placeholder="até" value={f.ano_ate} onChange={up('ano_ate')} style={{ width: 80 }} /></>}
      <button className="b sec" onClick={() => set(FILTRO_VAZIO)}>Limpar</button>
    </div>
  );
}
