import { usePoll } from '../api';

export function PerfilModal({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const { data: p, erro } = usePoll<any>(`/pesquisadores/${id}`);
  return (
    <div className="modal" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <button className="b sec" onClick={onClose} style={{ float: 'right' }}>fechar</button>
        {erro && <p className="err">{erro}</p>}
        {!p && !erro && <p className="muted">Carregando…</p>}
        {p && (<>
          <h2 style={{ marginTop: 0 }}>{p.nome}</h2>
          <p className="muted">{[p.instituicao, p.uf, p.regiao].filter(Boolean).join(' · ')} · <a href={`http://lattes.cnpq.br/${p.id}`} target="_blank" rel="noreferrer">Lattes</a>
            {p.orcid && <> · <a href={`https://orcid.org/${p.orcid}`} target="_blank" rel="noreferrer">ORCID</a></>}</p>
          {p.resumo && <p>{p.resumo}</p>}
          <div>{p.grandes_areas.map((t: string) => <span className="tag" key={t}>{t}</span>)}{p.areas.slice(0, 8).map((t: string) => <span className="tag" key={t}>{t}</span>)}</div>
          <h3>Colaboradores ({p.colaboradores.length})</h3>
          <table><tbody>{p.colaboradores.map((c: any) => <tr key={c.id}><td>{c.nome}</td><td className="num">{c.obras} obra(s)</td><td><a href="#" onClick={(e) => { e.preventDefault(); onOpen(c.id); }}>ver</a></td></tr>)}</tbody></table>
          <h3>Orientações ({p.orientacoes.length})</h3>
          <table><tbody>{p.orientacoes.slice(0, 30).map((o: any, i: number) => <tr key={i}><td>{o.orientado_nome}</td><td>{o.nivel}</td><td>{o.titulo}</td><td className="num">{o.ano}</td></tr>)}</tbody></table>
          <h3>Obras ({p.obras.length})</h3>
          <table><tbody>{p.obras.map((o: any) => <tr key={o.id}><td>{o.titulo}<div className="muted">{o.veiculo}</div></td><td>{o.tipo}</td><td className="num">{o.ano}</td></tr>)}</tbody></table>
        </>)}
      </div>
    </div>
  );
}
