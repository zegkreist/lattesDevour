import { useEffect, useState } from 'react';
import { api, qs } from '../api';
import { Filtros, FILTRO_VAZIO, type Filtro } from './Filtros';
import { PerfilModal } from './PerfilModal';
import { Alternador, Card, fmt, Paginas, rotuloTipo } from './ui';

function useDebounced<T>(v: T, ms = 300): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

const MODOS = [['obras', 'Obras'], ['pesquisadores', 'Pesquisadores']] as const;

export function Busca() {
  const [modo, setModo] = useState<'obras' | 'pesquisadores'>('obras');
  const [f, setF] = useState<Filtro>(FILTRO_VAZIO);
  const [page, setPage] = useState(1);
  const [res, setRes] = useState<{ total: number; itens: any[] } | null>(null);
  const [perfil, setPerfil] = useState<string | null>(null);
  const fd = useDebounced(f);
  useEffect(() => setPage(1), [fd, modo]);
  useEffect(() => { api(`/${modo}${qs({ ...fd, page })}`).then(setRes).catch(() => setRes({ total: 0, itens: [] })); }, [fd, modo, page]);
  const paginas = Math.max(1, Math.ceil((res?.total ?? 0) / 30));
  return (
    <div className="grid">
      <Card>
        <Alternador valor={modo} opcoes={MODOS} onChange={setModo} />
        <Filtros f={f} set={setF} mostrar={modo === 'obras' ? ['q', 'regiao', 'uf', 'inst', 'tema', 'tipo', 'kw', 'ano_de'] : ['q', 'regiao', 'uf', 'inst', 'tema']} />
      </Card>
      <Card titulo={`${fmt(res?.total)} resultado(s)`}>
        {res && res.itens.length === 0 ? <p className="muted">Nada encontrado. A base só tem o que já foi parseado.</p> : (
          <div className="tw">
            {modo === 'obras' ? (
              <table><thead><tr><th>Título</th><th>Autores</th><th>Veículo</th><th>Tipo</th><th className="num">Ano</th></tr></thead><tbody>
                {res?.itens.map((o) => (
                  <tr key={o.id}><td style={{ minWidth: 260 }}>{o.doi ? <a href={`https://doi.org/${o.doi}`} target="_blank" rel="noreferrer">{o.titulo}</a> : o.titulo}
                    {(o.palavras_chave ?? []).length > 0 && <div>{o.palavras_chave.slice(0, 5).map((k: string) => <span className="tag" key={k}>{k}</span>)}</div>}</td>
                    <td style={{ minWidth: 160 }}>{o.autores}</td><td>{o.veiculo}</td><td>{rotuloTipo(o.tipo)}</td><td className="num">{o.ano}</td></tr>
                ))}
              </tbody></table>
            ) : (
              <table><thead><tr><th>Nome</th><th>Instituição</th><th>UF</th><th>Temas</th><th className="num">Obras</th></tr></thead><tbody>
                {res?.itens.map((p) => (
                  <tr key={p.id}><td><a href="#" onClick={(e) => { e.preventDefault(); setPerfil(p.id); }}>{p.nome}</a></td><td>{p.instituicao}</td><td>{p.uf}</td>
                    <td>{(p.grandes_areas ?? []).slice(0, 3).map((t: string) => <span className="tag" key={t}>{t}</span>)}</td><td className="num">{fmt(p.obras)}</td></tr>
                ))}
              </tbody></table>
            )}
          </div>
        )}
        <Paginas page={page} total={paginas} set={setPage} />
      </Card>
      {perfil && <PerfilModal id={perfil} onClose={() => setPerfil(null)} onOpen={setPerfil} />}
    </div>
  );
}
