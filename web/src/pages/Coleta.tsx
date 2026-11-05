import { ChevronRight, ExternalLink, Play, Plus, RotateCcw, Square, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, usePoll } from '../api';
import { Aviso, Badge, Campo, Card, Carregando, faseDoColetor, fmt, StatusBadge, statusRotulo, when } from './ui';

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
  if (!c) return <Carregando />;
  const novnc = c.novncUrl || `${location.protocol}//${location.hostname}:6080/vnc.html?autoconnect=true&resize=scale`;
  const config = (body: object) => api('/coletor/config', { method: 'PUT', body }).then(reload);
  const ritmos = RITMOS.includes(c.config.porHora) ? RITMOS : [...RITMOS, c.config.porHora].sort((a, b) => a - b);
  const fase = faseDoColetor(c);
  return (
    <div className="grid">
      {c.fase === 'aguardando_captcha' && <Aviso><b>Captcha aguardando</b> ({c.atual}): resolva no <a href={novnc} target="_blank" rel="noreferrer">navegador do coletor</a>; o app segue sozinho.</Aviso>}
      {c.fase === 'pausado' && <Aviso>{c.mensagem}</Aviso>}
      <Card
        titulo="Coletor"
        desc={c.rodando ? c.mensagem : undefined}
        acao={(
          <div className="row">
            <a className="b sec" href={novnc} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}><ExternalLink size={14} /> noVNC</a>
            <button className="b sec" disabled={!c.rodando} onClick={() => api('/coletor/parar', { body: {} }).then(reload)}><Square size={14} /> Parar</button>
            <button className="b" disabled={c.rodando} onClick={() => api('/coletor/iniciar', { body: {} }).then(reload)}><Play size={14} /> Iniciar</button>
          </div>
        )}
      >
        <div className="campos" style={{ alignItems: 'start' }}>
          <div className="campo"><span>Estado</span><div className="valor"><Badge tom={fase.tom}>{fase.rotulo}</Badge><span className="muted">{fmt(c.baixadosNaSessao)} nesta sessão</span></div></div>
          <Campo rotulo="Caminho de download" title="Caminho de download (em teste)">
            <select value={c.config.caminho} onChange={(e) => config({ caminho: e.target.value })}>
              {CAMINHOS.map(([v, rotulo, dica]) => <option key={v} value={v} title={dica}>{rotulo} ({fmt(c.porCaminho?.[v] ?? 0)})</option>)}
            </select>
          </Campo>
          <Campo rotulo="Ritmo" title="Ritmo, contado de início a início">
            <select value={c.config.porHora} onChange={(e) => config({ porHora: Number(e.target.value) })}>
              {ritmos.map((n) => <option key={n} value={n}>{n} CVs/h (1 a cada {Math.round(3600 / n)} s)</option>)}
            </select>
          </Campo>
          {c.config.caminho === 'cv' && (
            <div className="campo"><span>2Captcha</span><div className="valor">{c.captchaAuto ? <Badge tom="ok">ativo</Badge> : <Badge tom="neutro" title="Defina a chave em Configurações">sem chave</Badge>}</div></div>
          )}
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
    <Card titulo="Adicionar CVs" desc="Rede = orientador, orientados e coautores que aparecem no CV com link do Lattes. CV já coletado não é baixado de novo.">
      <textarea value={texto} onChange={(e) => setTexto(e.target.value)}
        placeholder="links (lattes.cnpq.br/…) ou IDs de 16 dígitos, um ou vários" />
      <div className="row">
        <select value={destino} onChange={(e) => setDestino(e.target.value)} aria-label="Onde entra na fila">
          <option value="topo">Topo da fila</option>
          <option value="rede1">Topo + rede (1 nível)</option>
          <option value="rede2">Topo + rede (2 níveis)</option>
          <option value="fim">Fim da fila (lista grande)</option>
        </select>
        <button className="b" disabled={!texto.trim()} onClick={() => enviar(texto)}><Plus size={14} /> Adicionar</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
      {pedidos.length > 0 && st && (
        <>
          <p className="muted">
            <b>{fmt(prontos)}/{fmt(pedidos.length)} prontos</b>
            {st.redeNaFila > 0 && <> · rede: {fmt(st.redeNaFila)} na frente da fila</>}
            {!st.coletorRodando && pedidos.some((p) => porId.get(p.id)?.status === 'pendente') && <> · <b>coletor parado</b></>}
          </p>
          <div className="tw"><table><tbody>{pedidos.map((p) => {
            const i = porId.get(p.id) ?? {};
            return (
              <tr key={p.id}>
                <td><code>{p.id}</code> <span className="muted">{i.nome ?? i.nomeHint ?? ''}</span></td>
                <td>
                  <div className="row">
                    {i.status === 'parseado' ? <Badge tom="ok">{p.acao === 'enfileirado' ? 'pronto' : 'já coletado'} · {fmt(i.obras ?? 0)} obras</Badge>
                      : i.status === 'pendente' ? <Badge tom="neutro">posição {fmt(i.posicao)}</Badge>
                      : FASES[i.status] ? <Badge tom={i.status === 'aguardando_captcha' ? 'warn' : 'info'}>{FASES[i.status]}</Badge>
                      : <span className="err">{i.status ?? '?'}{i.ultimoErro ? `: ${i.ultimoErro}` : ''}</span>}
                    {p.acao === 'ja_coletado' && i.status === 'parseado' && <button className="b sec peq" onClick={() => enviar(p.id, true)}>Coletar de novo</button>}
                  </div>
                </td>
              </tr>
            );
          })}</tbody></table></div>
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
  const comErro = (fila ?? []).some((f) => f.ultimo_erro);
  return (
    <details className="card">
      <summary>
        <ChevronRight className="seta" size={16} /><b>Fila</b>
        {Object.entries(stats?.fila ?? {}).map(([k, v]) => <StatusBadge key={k} status={k} n={v as number} />)}
      </summary>
      <div className="card-body">
        <div className="row">
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filtrar por status">
            <option value="">Todos os status</option>{['pendente', 'baixando', 'aguardando_captcha', 'html', 'baixado', 'parseado', 'erro', 'sem_cv'].map((s) => <option key={s} value={s}>{statusRotulo(s)}</option>)}
          </select>
          <button className="b sec" onClick={() => api('/fila/retry-erros', { body: {} }).then((r) => setMsg(`${r.reenfileirados} para baixar · ${r.reprocessados} só reprocessar (já em disco)`))}><RotateCcw size={14} /> Reenfileirar erros</button>
          <button className="b sec" onClick={async () => {
            const n = stats?.fila?.pendente ?? 0;
            if (!n || !confirm(`Remover ${fmt(n)} CV(s) pendente(s) da fila? Quem já foi baixado ou está baixando não é afetado.`)) return;
            const r = await api('/fila?status=pendente', { method: 'DELETE' });
            setMsg(`${fmt(r.removidos)} pendente(s) removido(s)`);
          }}><Trash2 size={14} /> Limpar pendentes</button>
          <button className="b sec" onClick={async () => {
            const n = (stats?.fila?.erro ?? 0) + (stats?.fila?.sem_cv ?? 0);
            if (!n || !confirm(`Remover ${fmt(n)} CV(s) com erro/sem CV da fila?`)) return;
            const r = await Promise.all([api('/fila?status=erro', { method: 'DELETE' }), api('/fila?status=sem_cv', { method: 'DELETE' })]);
            setMsg(`${fmt(r[0].removidos + r[1].removidos)} com erro removido(s)`);
          }}><Trash2 size={14} /> Limpar erros</button>
          {msg && <span className="muted">{msg}</span>}
        </div>
        <div className="tw">
          <table><thead><tr><th>ID</th><th>Status</th><th>Nome</th><th>Origem</th>{comErro && <th>Erro</th>}<th>Atualizado</th></tr></thead><tbody>
            {(fila ?? []).map((f) => (
              <tr key={f.lattes_id}><td>{f.lattes_id}</td><td><StatusBadge status={f.status} /></td><td>{f.nome_hint}</td><td>{f.origem}</td>
                {comErro && <td className="err">{f.ultimo_erro}</td>}<td className="quebra-nao">{when(f.atualizado_em)}</td></tr>
            ))}
          </tbody></table>
        </div>
      </div>
    </details>
  );
}
