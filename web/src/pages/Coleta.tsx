import { useEffect, useState } from 'react';
import { api, usePoll } from '../api';
import { Card, fmt, when } from './ui';

const RITMOS = [60, 120, 180, 300, 600];
const CAMINHOS = [
  ['cv', 'Link direto', 'captcha “não sou um robô” (v2): 2Captcha ou noVNC'],
  ['previa', 'Prévia da busca', 'captcha invisível (v3), como o scriptLattes; se falhar, usa o link direto'],
] as const;
const FASES: Record<string, string> = {
  baixando: 'baixando…',
  aguardando_captcha: 'aguardando captcha',
  html: 'processando…',
  baixado: 'processando…',
};

export function Coleta() {
  const { data: c, reload } = usePoll<any>('/coletor', 2000);
  if (!c) return <p className="muted">Carregando…</p>;
  const novnc = c.novncUrl || `${location.protocol}//${location.hostname}:6080/vnc.html?autoconnect=true&resize=scale`;
  const config = (body: object) => api('/coletor/config', { method: 'PUT', body }).then(reload);
  const ritmos = RITMOS.includes(c.config.porHora) ? RITMOS : [...RITMOS, c.config.porHora].sort((a, b) => a - b);
  return (
    <div className="grid">
      {c.fase === 'aguardando_captcha' && <div className="banner"><b>Captcha aguardando</b> ({c.atual}): resolva no <a href={novnc} target="_blank" rel="noreferrer">navegador do coletor</a>; o app segue sozinho.</div>}
      {c.fase === 'pausado' && <div className="banner">{c.mensagem}</div>}
      <Card>
        <div className="row">
          <b>Coletor</b>
          <span className={c.fase === 'aguardando_captcha' ? 'st-aguardando_captcha' : 'muted'}>{c.rodando ? c.mensagem : 'parado'} · {fmt(c.baixadosNaSessao)} nesta sessão</span>
          <button className="b" disabled={c.rodando} onClick={() => api('/coletor/iniciar', { body: {} }).then(reload)}>Iniciar</button>
          <button className="b sec" disabled={!c.rodando} onClick={() => api('/coletor/parar', { body: {} }).then(reload)}>Parar</button>
          <select value={c.config.caminho} onChange={(e) => config({ caminho: e.target.value })} title="Caminho de download (em teste)">
            {CAMINHOS.map(([v, rotulo, dica]) => <option key={v} value={v} title={dica}>{rotulo} ({fmt(c.porCaminho?.[v] ?? 0)})</option>)}
          </select>
          <select value={c.config.porHora} onChange={(e) => config({ porHora: Number(e.target.value) })} title="Ritmo, contado de início a início">
            {ritmos.map((n) => <option key={n} value={n}>{n} CVs/h (1 a cada {Math.round(3600 / n)} s)</option>)}
          </select>
          {c.config.caminho === 'cv' && <span className="muted">2Captcha: {c.captchaAuto ? 'ativo' : 'sem chave (Configurações)'}</span>}
          <a href={novnc} target="_blank" rel="noreferrer">noVNC</a>
        </div>
      </Card>
      <AdicionarCVs />
      <Fila />
    </div>
  );
}

/** Um ou vários links/IDs: topo da fila (com ou sem a rede) e acompanhamento, ou fim da fila (listas grandes). */
function AdicionarCVs() {
  const [texto, setTexto] = useState('');
  const [destino, setDestino] = useState('topo');
  const [pedidos, setPedidos] = useState<{ id: string; acao: string }[]>([]);
  const [st, setSt] = useState<any>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (!pedidos.length) return;
    let vivo = true;
    const ler = () => api('/coletar/status', { body: { ids: pedidos.map((p) => p.id) } }).then((r) => vivo && setSt(r)).catch(() => {});
    ler();
    const t = setInterval(ler, 3000);
    return () => { vivo = false; clearInterval(t); };
  }, [pedidos]);
  const enviar = async (alvo: string, recoletar = false) => {
    setMsg('');
    try {
      if (destino === 'fim' && !recoletar) {
        const r = await api('/fila/enfileirar', { body: { texto: alvo } });
        setMsg(`${fmt(r.encontrados)} ID(s), ${fmt(r.novos)} novo(s) no fim da fila`);
      } else {
        const rede = destino === 'rede2' ? 2 : destino === 'rede1' ? 1 : 0;
        const r = await api('/coletar', { body: { texto: alvo, recoletar, rede } });
        setPedidos((ant) => (recoletar ? ant.map((p) => r.itens.find((i: any) => i.id === p.id) ?? p) : r.itens));
        if (r.ignoradosK) setMsg(`${r.ignoradosK} link(s) com ID interno (K…) ignorado(s)`);
      }
      if (!recoletar) setTexto('');
    } catch (e: any) {
      setMsg(e.message);
    }
  };
  const porId = new Map<string, any>((st?.itens ?? []).map((i: any) => [i.id, i]));
  const prontos = pedidos.filter((p) => porId.get(p.id)?.status === 'parseado').length;
  return (
    <Card titulo="Adicionar CVs">
      <textarea style={{ minHeight: 64 }} value={texto} onChange={(e) => setTexto(e.target.value)}
        placeholder="links (lattes.cnpq.br/…) ou IDs de 16 dígitos, um ou vários" />
      <div className="row">
        <select value={destino} onChange={(e) => setDestino(e.target.value)}>
          <option value="topo">topo da fila</option>
          <option value="rede1">topo + rede (1 nível)</option>
          <option value="rede2">topo + rede (2 níveis)</option>
          <option value="fim">fim da fila (lista grande)</option>
        </select>
        <button className="b" disabled={!texto.trim()} onClick={() => enviar(texto)}>Adicionar</button>
        <span className="muted" title="Rede: quem aparece no CV com link do Lattes (orientador, orientados, coautores). CV já coletado não é baixado de novo.">{msg || 'rede = orientador, orientados e coautores com Lattes'}</span>
      </div>
      {pedidos.length > 0 && st && (
        <>
          <p className="muted">
            <b>{fmt(prontos)}/{fmt(pedidos.length)} prontos</b>
            {st.redeNaFila > 0 && <> · rede: {fmt(st.redeNaFila)} na frente da fila</>}
            {!st.coletorRodando && pedidos.some((p) => porId.get(p.id)?.status === 'pendente') && <> · <b>coletor parado</b></>}
          </p>
          <table><tbody>{pedidos.map((p) => {
            const i = porId.get(p.id) ?? {};
            return (
              <tr key={p.id}>
                <td><code>{p.id}</code> <span className="muted">{i.nome ?? i.nomeHint ?? ''}</span></td>
                <td>
                  {i.status === 'parseado' ? <span className="st-parseado">{p.acao === 'enfileirado' ? 'pronto' : 'já coletado'} · {fmt(i.obras ?? 0)} obras</span>
                    : i.status === 'pendente' ? <>posição {fmt(i.posicao)}</>
                    : FASES[i.status] ? <span className="st-aguardando_captcha">{FASES[i.status]}</span>
                    : <span className="err">{i.status ?? '?'}{i.ultimoErro ? `: ${i.ultimoErro}` : ''}</span>}
                  {p.acao === 'ja_coletado' && i.status === 'parseado' && <> <button className="b sec" onClick={() => enviar(p.id, true)}>coletar de novo</button></>}
                </td>
              </tr>
            );
          })}</tbody></table>
        </>
      )}
    </Card>
  );
}

function Fila() {
  const { data: stats } = usePoll<any>('/stats', 5000);
  const [status, setStatus] = useState('');
  const [msg, setMsg] = useState('');
  const { data: fila } = usePoll<any[]>(`/fila?limit=15${status ? `&status=${status}` : ''}`, 5000);
  const resumo = Object.entries(stats?.fila ?? {}).map(([k, v]) => `${k} ${fmt(v as number)}`).join(' · ');
  const comErro = (fila ?? []).some((f) => f.ultimo_erro);
  return (
    <details className="card">
      <summary><b>Fila</b> <span className="muted">{resumo}</span></summary>
      <div className="row" style={{ marginTop: 10 }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">todos</option>{['pendente', 'baixando', 'aguardando_captcha', 'html', 'baixado', 'parseado', 'erro', 'sem_cv'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <button className="b sec" onClick={() => api('/fila/retry-erros', { body: {} }).then((r) => setMsg(`${r.reenfileirados} para baixar · ${r.reprocessados} só reprocessar (já em disco)`))}>Reenfileirar erros</button>
        <span className="muted">{msg}</span>
      </div>
      <table><thead><tr><th>ID</th><th>Status</th><th>Nome</th><th>Origem</th>{comErro && <th>Erro</th>}<th>Atualizado</th></tr></thead><tbody>
        {(fila ?? []).map((f) => (
          <tr key={f.lattes_id}><td>{f.lattes_id}</td><td className={`st-${f.status}`}>{f.status}</td><td>{f.nome_hint}</td><td>{f.origem}</td>
            {comErro && <td className="err">{f.ultimo_erro}</td>}<td>{when(f.atualizado_em)}</td></tr>
        ))}
      </tbody></table>
    </details>
  );
}
