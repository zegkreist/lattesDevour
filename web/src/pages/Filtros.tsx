import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { usePoll } from '../api';
import { Campo, rotuloTipo } from './ui';

export interface Filtro { q: string; uf: string; regiao: string; tema: string; inst: string; tipo: string; kw: string; ano_de: string; ano_ate: string }
export const FILTRO_VAZIO: Filtro = { q: '', uf: '', regiao: '', tema: '', inst: '', tipo: '', kw: '', ano_de: '', ano_ate: '' };

/** `children`: campos extras da tela, na mesma grade dos filtros. */
export function Filtros({ f, set, mostrar, children }: { f: Filtro; set: (f: Filtro) => void; mostrar: (keyof Filtro)[]; children?: ReactNode }) {
  const { data } = usePoll<any>('/facets');
  const up = (k: keyof Filtro) => (e: { target: { value: string } }) => set({ ...f, [k]: e.target.value });
  const sel = (k: keyof Filtro, rotulo: string, todos: string, itens: { v: string; n: string }[] = [], exibir = (v: string) => v) => mostrar.includes(k) && (
    <Campo rotulo={rotulo}>
      <select value={f[k]} onChange={up(k)}>
        <option value="">{todos}</option>{itens.map((i) => <option key={i.v} value={i.v}>{exibir(i.v)} ({i.n})</option>)}
      </select>
    </Campo>
  );
  return (
    <div className="campos">
      {mostrar.includes('q') && <Campo rotulo="Texto" largo><input placeholder="Nome, título ou assunto" value={f.q} onChange={up('q')} /></Campo>}
      {sel('regiao', 'Região', 'Todas', data?.regioes)}{sel('uf', 'UF', 'Todas', data?.ufs)}{sel('inst', 'Instituição', 'Todas', data?.instituicoes)}
      {sel('tema', 'Tema (grande área)', 'Todos', data?.temas)}{sel('tipo', 'Tipo de obra', 'Todos', data?.tipos, rotuloTipo)}
      {mostrar.includes('kw') && <Campo rotulo="Palavra-chave"><input value={f.kw} onChange={up('kw')} /></Campo>}
      {mostrar.includes('ano_de') && <><Campo rotulo="Ano de"><input inputMode="numeric" value={f.ano_de} onChange={up('ano_de')} /></Campo><Campo rotulo="Até"><input inputMode="numeric" value={f.ano_ate} onChange={up('ano_ate')} /></Campo></>}
      {children}
      <div><button className="b sec" onClick={() => set(FILTRO_VAZIO)}><X size={14} /> Limpar</button></div>
    </div>
  );
}
