import { useState } from 'react';
import { api, usePoll } from '../api';
import { Card, fmt, Progresso } from './ui';

export function Instituicoes() {
  const { data, reload } = usePoll<any[]>('/instituicoes-alvo', 4000);
  const [texto, setTexto] = useState('');
  const [msg, setMsg] = useState('');
  const add = async () => { const r = await api('/instituicoes-alvo', { body: { texto } }); setMsg(`${r.adicionadas} adicionada(s)`); setTexto(''); reload(); };
  return (
    <div className="grid">
      <Card titulo="Lista de instituições alvo">
        <p className="muted">Uma por linha (“Nome;UF”). A descoberta busca a afiliação no ORCID e enfileira quem tem o link do Lattes no perfil.</p>
        <textarea value={texto} onChange={(e) => setTexto(e.target.value)} placeholder={'Universidade Federal de Minas Gerais;MG\nUniversidade de São Paulo;SP'} />
        <div className="row"><button className="b" disabled={!texto.trim()} onClick={add}>Adicionar</button>
          <button className="b sec" onClick={() => api('/instituicoes-alvo/descobrir-todas', { body: {} }).then(reload)}>Descobrir todas</button><span className="muted">{msg}</span></div>
      </Card>
      <BuscaOrcid />
      <Card titulo="O que falta baixar">
        <table>
          <thead><tr><th>Instituição</th><th>UF</th><th>Descoberta</th><th className="num">IDs</th><th className="num">Pendentes</th><th className="num">Parseados</th><th className="num">Falhas</th><th>Progresso</th><th /></tr></thead>
          <tbody>
            {(data ?? []).map((a) => (
              <tr key={a.id}>
                <td>{a.nome}</td><td>{a.uf}</td>
                <td className={`st-${a.status}`}>{a.descobrindo_agora ? 'descobrindo…' : a.status}{a.descoberta_total ? ` (${fmt(a.descoberta_cursor)}/${fmt(a.descoberta_total)} perfis ORCID)` : ''}{a.ultimo_erro && <div className="err">{a.ultimo_erro}</div>}</td>
                <td className="num">{fmt(a.ids)}</td><td className="num">{fmt(a.pendentes + a.em_andamento)}</td><td className="num">{fmt(a.parseados)}</td><td className="num">{fmt(a.falhas)}</td>
                <td><Progresso parseados={a.parseados} baixados={a.baixados} falhas={a.falhas} total={a.ids} /></td>
                <td className="row">
                  <button className="b sec" disabled={a.descobrindo_agora} onClick={() => api(`/instituicoes-alvo/${a.id}/descobrir`, { body: {} }).then(reload)}>Descobrir</button>
                  <button className="b sec" onClick={() => confirm(`Remover ${a.nome}? (os IDs da fila ficam)`) && api(`/instituicoes-alvo/${a.id}`, { method: 'DELETE' }).then(reload)}>×</button>
                </td>
              </tr>
            ))}
            {data?.length === 0 && <tr><td colSpan={9} className="muted">Nenhuma instituição ainda.</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/** Pesquisador por nome no ORCID: só serve para quem pôs o link do Lattes no perfil. */
function BuscaOrcid() {
  const [nome, setNome] = useState('');
  const [inst, setInst] = useState('');
  const [cands, setCands] = useState<any[] | null>(null);
  const [msg, setMsg] = useState('');
  const buscar = () => api('/descoberta/nome', { body: { nome, instituicao: inst } }).then(setCands).catch((e) => setMsg(e.message));
  return (
    <Card titulo="Pesquisador por nome (ORCID)">
      <div className="row">
        <input placeholder="Nome" value={nome} onChange={(e) => setNome(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && nome.trim() && buscar()} />
        <input placeholder="Instituição (opcional)" value={inst} onChange={(e) => setInst(e.target.value)} />
        <button className="b" disabled={!nome.trim()} onClick={buscar}>Buscar</button>
        <span className="muted">{msg}</span>
      </div>
      {cands && (
        <table><tbody>
          {cands.map((x) => (
            <tr key={x.orcid}><td>{x.nome}</td><td className="muted">{x.instituicoes.slice(0, 2).join('; ')}</td>
              <td>{x.lattesId
                ? <button className="b sec" onClick={() => api('/coletar', { body: { texto: x.lattesId } }).then((r) => setMsg(`${x.nome}: ${r.itens[0].acao.replace('_', ' ')}`))}>Coletar {x.lattesId}</button>
                : <span className="muted">sem link do Lattes no ORCID</span>}</td></tr>
          ))}
          {cands.length === 0 && <tr><td className="muted">Nada encontrado.</td></tr>}
        </tbody></table>
      )}
    </Card>
  );
}
