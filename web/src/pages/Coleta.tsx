import { useState } from 'react';
import { api, usePoll } from '../api';
import { Card, fmt, when } from './ui';

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
  const [delay, setDelay] = useState<number | ''>('');
  if (!c) return <p className="muted">Carregando…</p>;
  const esperando = c.fase === 'aguardando_captcha';
  return (
    <div className="grid">
      {esperando && <div className="banner"><b>Captcha aguardando:</b> {c.mensagem}. <a href={c.novncUrl} target="_blank" rel="noreferrer">Abrir o navegador do coletor (noVNC)</a>, resolva o reCAPTCHA e confirme o download; o app segue sozinho.</div>}
      {c.fase === 'pausado' && <div className="banner">{c.mensagem}</div>}
      <Card titulo="Coletor">
        <p>Estado: <b className={esperando ? 'st-aguardando_captcha' : ''}>{c.rodando ? c.fase : 'parado'}</b> {c.atual && <>· {c.atual}</>} · baixados nesta sessão: {c.baixadosNaSessao}</p>
        <p className="muted">O Lattes exige reCAPTCHA a cada currículo. O coletor abre cada CV num navegador real e espera uma pessoa resolver; não há serviço de quebra de captcha. Para volume, peça o Extrator Lattes ao CNPq e solte os XMLs/zips na pasta <code>data/import</code>.</p>
        <div className="row">
          <button className="b" disabled={c.rodando} onClick={() => api('/coletor/iniciar', { body: {} }).then(reload)}>Iniciar</button>
          <button className="b sec" disabled={!c.rodando} onClick={() => api('/coletor/parar', { body: {} }).then(reload)}>Parar</button>
          <a href={c.novncUrl} target="_blank" rel="noreferrer">navegador (noVNC)</a>
          <span className="muted">pausa entre CVs (ms):</span>
          <input type="number" style={{ width: 90 }} value={delay === '' ? c.config.delayMs : delay} onChange={(e) => setDelay(Number(e.target.value))} />
          <button className="b sec" onClick={() => api('/coletor/config', { method: 'PUT', body: { delayMs: delay === '' ? c.config.delayMs : delay } }).then(reload)}>Salvar</button>
        </div>
      </Card>
      <div className="grid g2">
        <Card titulo="Importar pasta (Extrator do CNPq)">
          <p className="muted">A pasta <code>data/import</code> é varrida a cada 30 s: aceita <code>.xml</code> e <code>.zip</code> (um ou vários XMLs). Os arquivos entram direto no parser, sem captcha.</p>
          <button className="b" onClick={() => api('/importar-pasta', { body: {} }).then((r) => setMsg(`${r.importados} importado(s)${r.falhas.length ? ' · falhas: ' + r.falhas.join(' | ') : ''}`))}>Varrer agora</button>
          <span className="muted"> {msg}</span>
        </Card>
        <Card titulo="Adicionar IDs à fila">
          <p className="muted">Cole qualquer texto com IDs Lattes de 16 dígitos (lista do CNPq, URLs lattes.cnpq.br/…, CSV).</p>
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
            <option value="">todos</option>{['pendente', 'baixando', 'aguardando_captcha', 'baixado', 'parseado', 'erro', 'sem_cv'].map((s) => <option key={s}>{s}</option>)}
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
