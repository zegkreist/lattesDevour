import { useState } from 'react';
import { api, usePoll } from '../api';
import { Card, fmt, when } from './ui';

export function Config() {
  const { data: s, reload } = usePoll<any>('/stats');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const { data: ex, reload: reloadEx } = usePoll<any>('/exportar');
  const [msgEx, setMsgEx] = useState('');
  const [msgRep, setMsgRep] = useState('');
  return (
    <div className="grid g2">
      <Card titulo="Backup">
        <p className="muted">{s?.backupS3 ? <>Destino na nuvem: <code>{s.backupS3}</code></> : <>Sem nuvem configurada. Defina <code>BACKUP_S3_BUCKET</code> (e as credenciais AWS) no <code>.env</code> e reinicie.</>}</p>
        <p className="muted">Cada backup = dump do Postgres + tarball dos XMLs crus, mantidos em <code>data/backups</code> (últimos {7}) e enviados ao bucket se houver. Agendado diariamente no horário de Brasília (<code>BACKUP_HOUR</code>).</p>
        <button className="b" disabled={busy} onClick={async () => { setBusy(true); setMsg('executando…'); try { const r = await api('/backup', { body: {} }); setMsg(`ok: ${r.arquivos.length} arquivo(s) → ${r.destino}`); reload(); } catch (e: any) { setMsg(e.message); } setBusy(false); }}>Fazer backup agora</button>
        <p>{msg}</p>
      </Card>
      <Card titulo="Cópia em Parquet">
        <p className="muted">Um arquivo <code>.parquet</code> por tabela (compressão GZIP), sem senha, em <code>{ex?.dir ?? 'data/exports'}</code>: abre direto no pandas, DuckDB, Power BI. Sobrescrito a cada exportação; roda junto com o backup diário. A tabela de configurações (que guarda a chave do 2Captcha) fica de fora.</p>
        <button className="b" disabled={busy} onClick={async () => { setBusy(true); setMsgEx('exportando…'); try { const r = await api('/exportar', { body: {} }); setMsgEx(`ok: ${r.tabelas.length} tabela(s), ${fmt(r.tabelas.reduce((n: number, t: any) => n + t.linhas, 0))} linha(s)`); reloadEx(); } catch (e: any) { setMsgEx(e.message); } setBusy(false); }}>Exportar agora</button>
        <p>{msgEx}</p>
        {ex?.arquivos.length ? (
          <table><thead><tr><th>Arquivo</th><th>Tamanho</th><th>Gerado</th></tr></thead><tbody>
            {ex.arquivos.map((a: any) => <tr key={a.arquivo}><td>{a.arquivo}</td><td>{fmt(Math.ceil(a.bytes / 1024))} KB</td><td>{when(a.em)}</td></tr>)}
          </tbody></table>
        ) : <p className="muted">Nenhuma exportação ainda.</p>}
      </Card>
      <Card titulo="Reprocessar">
        <p className="muted">Repassa o parser em todos os XML/HTML em disco, inclusive arquivos soltos em <code>data/html</code> (ex.: salvos à mão do navegador), sem baixar nada. Cada CV troca só o que ele mesmo declarou: autoria, tags e detalhes das obras são refeitos a partir de todos os CVs que as citam. Use depois de atualizar o app.</p>
        <button className="b sec" onClick={() => confirm('Reprocessar TODOS os CVs em disco?') && api('/reprocessar', { body: {} }).then((r) => setMsgRep(`${fmt(r.reenfileirados)} CV(s) na fila de parse`)).catch((e) => setMsgRep(e.message))}>Reprocessar todos</button>
        <p>{msgRep}</p>
      </Card>
      <Card titulo="Sobre captcha">
        <p className="muted">O Lattes protege a busca e a página de cada CV com reCAPTCHA. Com a chave do 2Captcha (aba Coleta, ou <code>TWOCAPTCHA_API_KEY</code> no <code>.env</code>) o coletor resolve sozinho; sem ela, pausa e pede para uma pessoa resolver. O ritmo (60 a 180 CVs/hora) também fica na aba Coleta. Para extração em volume, a via oficial é o Extrator Lattes do CNPq (<code>atendimento@cnpq.br</code>, assunto “Solicitação de acesso ao Lattes Extrator”), que exige uma instituição de ensino/pesquisa.</p>
        {s && <p className="muted">Último backup: {s.backups[0] ? `${when(s.backups[0].em)} (${s.backups[0].ok ? 'ok' : 'falhou'})` : 'nenhum'}</p>}
      </Card>
    </div>
  );
}
