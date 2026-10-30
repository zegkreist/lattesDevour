import { useEffect, useState } from 'react';
import { api, usePoll } from '../api';
import { Card, fmt, when } from './ui';

const FASES: Record<string, string> = {
  baixando: 'baixando agora…',
  aguardando_captcha: 'aguardando captcha (noVNC)',
  html: 'baixado, processando…',
  baixado: 'baixado, processando…',
};
const ACAO: Record<string, string> = {
  enfileirado: 'na fila',
  em_andamento: 'já estava sendo baixado',
  ja_coletado: 'já coletado',
  rede_priorizada: 'já coletado; rede priorizada',
};

/** Cola um ou vários links/IDs, põe no topo da fila e acompanha cada um até estar no banco. */
function ColetarPorLink() {
  const [texto, setTexto] = useState('');
  const [rede, setRede] = useState(0);
  const [pedidos, setPedidos] = useState<{ id: string; acao: string }[]>([]);
  const [st, setSt] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [erro, setErro] = useState('');
  useEffect(() => {
    if (!pedidos.length) return;
    let vivo = true;
    const ler = () => api('/coletar/status', { body: { ids: pedidos.map((p) => p.id) } }).then((r) => vivo && setSt(r)).catch(() => {});
    ler();
    const t = setInterval(ler, 3000);
    return () => { vivo = false; clearInterval(t); };
  }, [pedidos]);
  const coletar = (alvo: string, recoletar = false) => {
    setErro('');
    api('/coletar', { body: { texto: alvo, recoletar, rede } })
      .then((r) => {
        setPedidos((ant) => recoletar ? ant.map((p) => r.itens.find((i: any) => i.id === p.id) ?? p) : r.itens);
        if (!recoletar) {
          setTexto('');
          setMsg(`${fmt(r.itens.length)} ID(s) recebido(s)${r.ignoradosK ? ` · ${r.ignoradosK} link(s) com ID interno (K…) ignorado(s): use o endereço lattes.cnpq.br/<ID>` : ''}`);
        }
      })
      .catch((e) => setErro(e.message));
  };
  const porId = new Map<string, any>((st?.itens ?? []).map((i: any) => [i.id, i]));
  const prontos = pedidos.filter((p) => porId.get(p.id)?.status === 'parseado').length;
  return (
    <Card titulo="Coletar CVs pelo link ou ID">
      <textarea value={texto} onChange={(e) => setTexto(e.target.value)}
        placeholder={'Um ou vários, um por linha (ou colados de qualquer jeito):\nhttp://lattes.cnpq.br/1234567890123456\n1234567890123456'} />
      <div className="row">
        <select value={rede} onChange={(e) => setRede(Number(e.target.value))} title="Depois de processar cada CV, quem aparece nele com link do Lattes também passa na frente">
          <option value={0}>só estes CVs</option>
          <option value={1}>+ rede (1 nível)</option>
          <option value={2}>+ rede (2 níveis)</option>
        </select>
        <button className="b" disabled={!texto.trim()} onClick={() => coletar(texto)}>Coletar</button>
        <span className="muted">{msg}</span>
      </div>
      <p className="muted">Links do CV (<code>lattes.cnpq.br/&lt;ID&gt;</code>, <code>cv?id=</code>) ou <b>só os IDs</b> (16 dígitos), um ou vários. Vão para o topo da fila, na ordem em que aparecem. Com “+ rede”, quem aparece em cada CV com link do Lattes (orientador, orientados, coautores) vem logo em seguida; 2 níveis inclui a rede deles. CV já coletado não é baixado de novo: só a rede é priorizada.</p>
      {erro && <p className="err">{erro}</p>}
      {pedidos.length > 0 && st && (
        <>
          <p>
            <b>{fmt(prontos)}/{fmt(pedidos.length)} prontos</b>
            {st.redeNaFila > 0 && <> · rede: {fmt(st.redeNaFila)} CV(s) na frente da fila</>}
            {!st.coletorRodando && pedidos.some((p) => porId.get(p.id)?.status === 'pendente') && <> · <b>o coletor está parado</b>: clique em Iniciar abaixo</>}
          </p>
          <table><tbody>{pedidos.map((p) => {
            const i = porId.get(p.id) ?? {};
            return (
              <tr key={p.id}>
                <td><code>{p.id}</code><br /><span className="muted">{i.nome ?? i.nomeHint ?? ''}</span></td>
                <td>
                  {i.status === 'parseado' ? (
                    <span className="st-parseado">{p.acao === 'enfileirado' ? 'pronto' : ACAO[p.acao]}: {fmt(i.obras ?? 0)} obras{i.caminho ? ` (via ${i.caminho === 'previa' ? 'prévia' : 'link direto'})` : ''}</span>
                  ) : i.status === 'pendente' ? (
                    <>na fila, posição {fmt(i.posicao)}</>
                  ) : FASES[i.status] ? (
                    <span className="st-aguardando_captcha">{FASES[i.status]}</span>
                  ) : (
                    <span className="err">{i.status ?? '?'}{i.ultimoErro ? `: ${i.ultimoErro}` : ''}</span>
                  )}
                  {p.acao === 'ja_coletado' && i.status === 'parseado' && <> <button className="b sec" onClick={() => coletar(p.id, true)}>Coletar de novo</button></>}
                </td>
              </tr>
            );
          })}</tbody></table>
        </>
      )}
    </Card>
  );
}

export function Coleta() {
  const { data: c, reload } = usePoll<any>('/coletor', 2000);
  const { data: stats } = usePoll<any>('/stats', 4000);
  const [status, setStatus] = useState('');
  const { data: fila } = usePoll<any[]>(`/fila?limit=40${status ? `&status=${status}` : ''}`, 4000);
  const [texto, setTexto] = useState('');
  const [nome, setNome] = useState('');
  const [instNome, setInstNome] = useState('');
  const [cands, setCands] = useState<any[] | null>(null);
  const [msg, setMsg] = useState('');
  const [porHora, setPorHora] = useState<number | ''>('');
  const [chave, setChave] = useState('');
  const [msgChave, setMsgChave] = useState('');
  if (!c) return <p className="muted">Carregando…</p>;
  const esperando = c.fase === 'aguardando_captcha';
  const ritmo = porHora === '' ? c.config.porHora : porHora;
  const intervalo = 3600 / ritmo;
  const k = c.config.chave2Captcha;
  const novnc = c.novncUrl || `${location.protocol}//${location.hostname}:6080/vnc.html?autoconnect=true&resize=scale`;
  const salvarChave = (valor: string) =>
    api('/coletor/2captcha', { method: 'PUT', body: { chave: valor } })
      .then((r) => { setChave(''); setMsgChave(valor ? `chave salva · saldo US$ ${r.saldo.toFixed(2)}` : 'chave do painel removida'); reload(); })
      .catch((e) => setMsgChave(e.message));
  return (
    <div className="grid">
      {esperando && <div className="banner"><b>Captcha aguardando:</b> {c.mensagem}. <a href={novnc} target="_blank" rel="noreferrer">Abrir o navegador do coletor (noVNC)</a>, resolva o reCAPTCHA e confirme o download; o app segue sozinho.</div>}
      {c.fase === 'pausado' && <div className="banner">{c.mensagem}</div>}
      <ColetarPorLink />
      <Card titulo="Coletor">
        <p>Estado: <b className={esperando ? 'st-aguardando_captcha' : ''}>{c.rodando ? c.fase : 'parado'}</b> {c.atual && <>· {c.atual}</>} · baixados nesta sessão: {c.baixadosNaSessao}</p>
        <p className="muted">O Lattes exige reCAPTCHA a cada currículo. {c.captchaAuto
          ? <>Modo automático: o captcha vai para o 2Captcha; se o token não abrir o CV, ele fica esperando uma pessoa no noVNC.</>
          : <>O coletor abre cada CV num navegador real e espera uma pessoa resolver (cadastre a chave do 2Captcha abaixo para o modo automático).</>}{' '}
          Para volume, peça o Extrator Lattes ao CNPq e solte os XMLs/zips na pasta <code>data/import</code>.</p>
        <div className="row">
          <button className="b" disabled={c.rodando} onClick={() => api('/coletor/iniciar', { body: {} }).then(reload)}>Iniciar</button>
          <button className="b sec" disabled={!c.rodando} onClick={() => api('/coletor/parar', { body: {} }).then(reload)}>Parar</button>
          <a href={novnc} target="_blank" rel="noreferrer">navegador (noVNC)</a>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <span className="muted">Caminho de download (teste):</span>
          {([['cv', 'Link direto do CV', 'captcha “não sou um robô” (v2): 2Captcha ou noVNC'], ['previa', 'Prévia da busca', 'captcha invisível (v3), como o scriptLattes; se falhar, usa o link direto']] as const).map(([v, rotulo, dica]) => (
            <label key={v} title={dica} style={{ cursor: 'pointer' }}>
              <input type="radio" name="caminho" checked={c.config.caminho === v}
                onChange={() => api('/coletor/config', { method: 'PUT', body: { caminho: v } }).then(reload)} /> {rotulo}
              <span className="muted"> ({fmt(c.porCaminho?.[v] ?? 0)} CVs)</span>
            </label>
          ))}
        </div>
      </Card>
      <div className="grid g2">
        <Card titulo="Ritmo da coleta">
          <div className="row">
            <input type="range" min={c.config.porHoraMin} max={c.config.porHoraMax} step={10} value={ritmo} onChange={(e) => setPorHora(Number(e.target.value))} />
            <b>{ritmo} CVs/hora</b>
            <button className="b sec" disabled={porHora === '' || porHora === c.config.porHora} onClick={() => api('/coletor/config', { method: 'PUT', body: { porHora: ritmo } }).then(() => { setPorHora(''); reload(); })}>Salvar</button>
          </div>
          <p>1 CV a cada <b>{Math.round(intervalo)} s</b> (varia entre {Math.round(intervalo * 0.8)} e {Math.round(intervalo * 1.2)} s) · até <b>{fmt(ritmo * 24)}</b> CVs/dia rodando 24 h.</p>
          <p className="muted">Entre {c.config.porHoraMin} e {c.config.porHoraMax} CVs/hora, contados de início a início. Cada captcha leva uns 20–60 s no 2Captcha, então em ritmos altos a taxa real pode ficar abaixo da configurada.</p>
        </Card>
        <Card titulo="2Captcha">
          <p>{k
            ? <>Chave ativa <code>••••{k.final}</code> ({k.origem === 'painel' ? 'salva aqui' : 'do .env'})</>
            : <span className="muted">Sem chave: o captcha fica com uma pessoa no noVNC.</span>}</p>
          <div className="row">
            <input type="password" placeholder={k ? 'trocar chave' : 'chave da API do 2Captcha'} value={chave} onChange={(e) => setChave(e.target.value)} autoComplete="off" />
            <button className="b" disabled={!chave.trim()} onClick={() => salvarChave(chave.trim())}>Salvar chave</button>
            {k?.origem === 'painel' && <button className="b sec" onClick={() => salvarChave('')}>Remover</button>}
          </div>
          <p className="muted">A chave é validada consultando o saldo antes de salvar. Fica no banco do app e nunca volta inteira para o navegador. {msgChave}</p>
        </Card>
      </div>
      <div className="grid g2">
        <Card titulo="Importar pasta (Extrator do CNPq)">
          <p className="muted">A pasta <code>data/import</code> é varrida a cada 30 s: aceita <code>.xml</code> e <code>.zip</code> (um ou vários XMLs). Os arquivos entram direto no parser, sem captcha.</p>
          <button className="b" onClick={() => api('/importar-pasta', { body: {} }).then((r) => setMsg(`${r.importados} importado(s)${r.falhas.length ? ' · falhas: ' + r.falhas.join(' | ') : ''}`))}>Varrer agora</button>
          <span className="muted"> {msg}</span>
        </Card>
        <Card titulo="Adicionar IDs à fila">
          <p className="muted">Para listas grandes (ex.: a lista de IDs do CNPq), <b>sem prioridade</b>: entram no fim da fila. Para passar na frente, use “Coletar CVs pelo link ou ID” acima. Aceita qualquer texto com IDs de 16 dígitos (URLs lattes.cnpq.br/…, CSV).</p>
          <textarea value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="http://lattes.cnpq.br/1234567890123456" />
          <button className="b" disabled={!texto.trim()} onClick={async () => { const r = await api('/fila/enfileirar', { body: { texto } }); setMsg(`${r.encontrados} ID(s) no texto, ${r.novos} novo(s)`); setTexto(''); }}>Enfileirar</button>
        </Card>
      </div>
      <Card titulo="Achar pesquisador por nome (ORCID)">
        <div className="row">
          <input placeholder="Nome" value={nome} onChange={(e) => setNome(e.target.value)} />
          <input placeholder="Instituição (opcional)" value={instNome} onChange={(e) => setInstNome(e.target.value)} />
          <button className="b" disabled={!nome.trim()} onClick={() => api('/descoberta/nome', { body: { nome, instituicao: instNome } }).then(setCands).catch((e) => setMsg(e.message))}>Buscar</button>
        </div>
        {cands && (
          <table><thead><tr><th>Nome</th><th>Instituições</th><th>Lattes</th><th /></tr></thead><tbody>
            {cands.map((x) => (
              <tr key={x.orcid}><td>{x.nome}</td><td>{x.instituicoes.slice(0, 2).join('; ')}</td><td>{x.lattesId ?? <span className="muted">sem link no ORCID</span>}</td>
                <td>{x.lattesId && <button className="b sec" onClick={() => api('/fila/enfileirar', { body: { texto: x.lattesId, origem: 'manual' } }).then((r) => setMsg(r.novos ? 'enfileirado' : 'já estava na fila'))}>Enfileirar</button>}</td></tr>
            ))}
            {cands.length === 0 && <tr><td colSpan={4} className="muted">Nada encontrado.</td></tr>}
          </tbody></table>
        )}
      </Card>
      <Card titulo={`Fila (${Object.entries(stats?.fila ?? {}).map(([k, v]) => `${k}: ${fmt(v as number)}`).join(' · ')})`}>
        <div className="row">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">todos</option>{['pendente', 'baixando', 'aguardando_captcha', 'html', 'baixado', 'parseado', 'erro', 'sem_cv'].map((s) => <option key={s}>{s}</option>)}
          </select>
          <button className="b sec" onClick={() => api('/fila/retry-erros', { body: {} }).then((r) => setMsg(`${r.reenfileirados} reenfileirado(s)`))}>Reenfileirar erros</button>
        </div>
        <table><thead><tr><th>ID</th><th>Status</th><th>Nome (hint)</th><th>Origem</th><th>Alvo</th><th>Erro</th><th>Atualizado</th></tr></thead><tbody>
          {(fila ?? []).map((f) => <tr key={f.lattes_id}><td>{f.lattes_id}</td><td className={`st-${f.status}`}>{f.status}</td><td>{f.nome_hint}</td><td>{f.origem}</td><td>{f.alvo}</td><td className="err">{f.ultimo_erro}</td><td>{when(f.atualizado_em)}</td></tr>)}
        </tbody></table>
      </Card>
    </div>
  );
}
