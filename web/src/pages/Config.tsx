import { useState } from 'react';
import { api, usePoll } from '../api';
import { Card, fmt, when } from './ui';

export function Config() {
  const { data: s, reload } = usePoll<any>('/stats');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid g2">
      <Card titulo="Backup">
        <p className="muted">{s?.backupS3 ? <>Destino na nuvem: <code>{s.backupS3}</code></> : <>Sem nuvem configurada. Defina <code>BACKUP_S3_BUCKET</code> (e as credenciais AWS) no <code>.env</code> e reinicie.</>}</p>
        <p className="muted">Cada backup = dump do Postgres + tarball dos XMLs crus, mantidos em <code>data/backups</code> (últimos {7}) e enviados ao bucket se houver. Agendado diariamente no horário de Brasília (<code>BACKUP_HOUR</code>).</p>
        <button className="b" disabled={busy} onClick={async () => { setBusy(true); setMsg('executando…'); try { const r = await api('/backup', { body: {} }); setMsg(`ok: ${r.arquivos.length} arquivo(s) → ${r.destino}`); reload(); } catch (e: any) { setMsg(e.message); } setBusy(false); }}>Fazer backup agora</button>
        <p>{msg}</p>
      </Card>
      <Card titulo="Reprocessar">
        <p className="muted">Reaplica o parser a todos os XMLs já em disco (sem baixar nada). Use depois de mudar um parser.</p>
        <button className="b sec" onClick={() => confirm('Reprocessar TODOS os CVs?') && api('/reprocessar', { body: { todos: true } }).then((r) => setMsg(`${fmt(r.reenfileirados)} CV(s) na fila de parse`))}>Reprocessar todos</button>
      </Card>
      <Card titulo="Sobre captcha">
        <p className="muted">O Lattes protege a busca e o download do XML com reCAPTCHA. Este app não integra serviços de quebra de captcha: o coletor pausa e pede para uma pessoa resolver (aba Coleta). Para extração em volume, a via oficial é o Extrator Lattes do CNPq (<code>atendimento@cnpq.br</code>, assunto “Solicitação de acesso ao Lattes Extrator”), que exige uma instituição de ensino/pesquisa.</p>
        {s && <p className="muted">Último backup: {s.backups[0] ? `${when(s.backups[0].em)} (${s.backups[0].ok ? 'ok' : 'falhou'})` : 'nenhum'}</p>}
      </Card>
    </div>
  );
}
