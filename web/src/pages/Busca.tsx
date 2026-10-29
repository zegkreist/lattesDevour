import { useEffect, useState } from 'react';
import { api, qs } from '../api';
import { Filtros, FILTRO_VAZIO, type Filtro } from './Filtros';
import { PerfilModal } from './PerfilModal';
import { Card, fmt } from './ui';

function useDebounced<T>(v: T, ms = 300): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

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
        <div className="row" style={{ marginBottom: 10 }}>
          <button className={`b ${modo === 'obras' ? '' : 'sec'}`} onClick={() => setModo('obras')}>Obras</button>
          <button className={`b ${modo === 'pesquisadores' ? '' : 'sec'}`} onClick={() => setModo('pesquisadores')}>Pesquisadores</button>
        </div>
        <Filtros f={f} set={setF} mostrar={modo === 'obras' ? ['q', 'regiao', 'uf', 'inst', 'tema', 'tipo', 'kw', 'ano_de'] : ['q', 'regiao', 'uf', 'inst', 'tema']} />
      </Card>
      <Card titulo={`${fmt(res?.total)} resultado(s)`}>
        {modo === 'obras' ? (
          <table><thead><tr><th>Título</th><th>Autores</th><th>Veículo</th><th>Tipo</th><th className="num">Ano</th></tr></thead><tbody>
            {res?.itens.map((o) => (
              <tr key={o.id}><td>{o.doi ? <a href={`https://doi.org/${o.doi}`} target="_blank" rel="noreferrer">{o.titulo}</a> : o.titulo}
                <div>{(o.palavras_chave ?? []).slice(0, 5).map((k: string) => <span className="tag" key={k}>{k}</span>)}</div></td>
                <td>{o.autores}</td><td>{o.veiculo}</td><td>{o.tipo}</td><td className="num">{o.ano}</td></tr>
            ))}
          </tbody></table>
        ) : (
          <table><thead><tr><th>Nome</th><th>Instituição</th><th>UF</th><th>Temas</th><th className="num">Obras</th></tr></thead><tbody>
            {res?.itens.map((p) => (
              <tr key={p.id}><td><a href="#" onClick={(e) => { e.preventDefault(); setPerfil(p.id); }}>{p.nome}</a></td><td>{p.instituicao}</td><td>{p.uf}</td>
                <td>{(p.grandes_areas ?? []).slice(0, 3).map((t: string) => <span className="tag" key={t}>{t}</span>)}</td><td className="num">{p.obras}</td></tr>
            ))}
          </tbody></table>
        )}
        {res && res.itens.length === 0 && <p className="muted">Nada encontrado. A base só tem o que já foi parseado.</p>}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="b sec" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button><span className="muted">{page} / {paginas}</span>
          <button className="b sec" disabled={page >= paginas} onClick={() => setPage(page + 1)}>›</button>
        </div>
      </Card>
      {perfil && <PerfilModal id={perfil} onClose={() => setPerfil(null)} onOpen={setPerfil} />}
    </div>
  );
}
