import { ListEnd, ListStart, Network } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, qs } from '../api';
import { Filtros, FILTRO_VAZIO, type Filtro } from './Filtros';
import { Card, fmt, Paginas, StatusBadge } from './ui';

/** Quem ainda não foi coletado mas aparece (coautoria/orientação) com pesquisadores que já foram. */
export function Proximos() {
  const [f, setF] = useState<Filtro>(FILTRO_VAZIO);
  const [page, setPage] = useState(1);
  const [res, setRes] = useState<{ total: number; itens: any[] } | null>(null);
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState('');
  useEffect(() => setPage(1), [f]);
  useEffect(() => {
    const t = setTimeout(() => { api(`/proximos${qs({ ...f, page })}`).then(setRes).catch(() => setRes({ total: 0, itens: [] })); }, 350);
    return () => clearTimeout(t);
  }, [f, page]);
  const itens = res?.itens ?? [];
  const alternar = (id: string) => setMarcados((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const todosMarcados = itens.length > 0 && itens.every((i) => marcados.has(i.id));
  const enviar = async (rede: number | null) => {
    const texto = [...marcados].join('\n');
    try {
      if (rede === null) {
        const r = await api('/fila/enfileirar', { body: { texto, origem: 'proximos' } });
        setMsg(`${fmt(r.novos)} novo(s) no fim da fila`);
      } else {
        const r = await api('/coletar', { body: { texto, rede } });
        setMsg(`${fmt(r.itens.length)} no topo da fila`);
      }
      setMarcados(new Set());
      api(`/proximos${qs({ ...f, page })}`).then(setRes);
    } catch (e: any) {
      setMsg(e.message);
    }
  };
  const paginas = Math.max(1, Math.ceil((res?.total ?? 0) / 50));
  return (
    <div className="grid">
      <Card
        titulo="Filtro da rede"
        desc={<>Escolhe a rede de quem já foi coletado. A lista mostra quem <b>ainda não foi coletado</b> e aparece como coautor ou orientado dessa rede, ordenado por quantos pesquisadores dela o citam.</>}
      >
        <Filtros f={f} set={setF} mostrar={['q', 'regiao', 'uf', 'inst', 'tema']} />
      </Card>
      <Card
        titulo={`${fmt(res?.total)} candidato(s)`}
        acao={(
          <div className="row">
            {msg && <span className="muted">{msg}</span>}
            <button className="b sec" disabled={!marcados.size} onClick={() => enviar(null)}><ListEnd size={14} /> Fim da fila</button>
            <button className="b sec" disabled={!marcados.size} onClick={() => enviar(1)} title="Topo da fila e, depois de coletado, a rede de cada um (1 nível)"><Network size={14} /> Topo + rede (1 nível)</button>
            <button className="b" disabled={!marcados.size} onClick={() => enviar(0)}><ListStart size={14} /> Topo da fila ({marcados.size})</button>
          </div>
        )}
      >
        {res && itens.length === 0 ? <p className="muted">Ninguém por perto: todos os citados com Lattes na rede já foram coletados (ou o filtro não pegou ninguém).</p> : (
          <div className="tw">
            <table>
              <thead><tr>
                <th><input type="checkbox" aria-label="Marcar todos" checked={todosMarcados} onChange={() => setMarcados(todosMarcados ? new Set() : new Set(itens.map((i) => i.id)))} /></th>
                <th>Nome</th><th>ID Lattes</th><th className="num">Da rede que citam</th><th className="num">Ligações</th><th>Ligado a</th><th>Fila</th>
              </tr></thead>
              <tbody>
                {itens.map((i) => (
                  <tr key={i.id}>
                    <td><input type="checkbox" aria-label={`Marcar ${i.nome}`} checked={marcados.has(i.id)} onChange={() => alternar(i.id)} /></td>
                    <td>{i.nome}</td>
                    <td className="quebra-nao"><a href={`http://lattes.cnpq.br/${i.id}`} target="_blank" rel="noreferrer">{i.id}</a></td>
                    <td className="num">{fmt(i.vinculos)}</td><td className="num">{fmt(i.ligacoes)}</td>
                    <td className="muted">{(i.ligado_a ?? []).join('; ')}{i.vinculos > (i.ligado_a ?? []).length ? '…' : ''}</td>
                    <td>{i.fila ? <StatusBadge status={i.fila} /> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Paginas page={page} total={paginas} set={setPage} />
      </Card>
    </div>
  );
}
