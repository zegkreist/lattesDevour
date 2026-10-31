import { useState } from 'react';
import { api, usePoll } from '../api';
import { Card, fmt, when } from './ui';

export function Config() {
  const { data: s, reload } = usePoll<any>('/stats');
  const { data: c, reload: reloadC } = usePoll<any>('/coletor');
  const { data: ex, reload: reloadEx } = usePoll<any>('/exportar');
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [chave, setChave] = useState('');
  const [busy, setBusy] = useState(false);
  const [apagando, setApagando] = useState(false);
  const [senha, setSenha] = useState('');
  const [erroApagar, setErroApagar] = useState('');
  const apagar = async () => {
    setBusy(true);
    setErroApagar('');
    try {
      const r = await api('/db/limpar', { body: { senha } });
      setApagando(false);
      diz('limpar', `${fmt(r.linhas)} linha(s) de ${r.tabelas} tabelas apagadas · cópia em ${r.dir}`);
      reload(); reloadEx();
    } catch (e: any) {
      setErroApagar(e.message);
    }
    setSenha('');
    setBusy(false);
  };
  const diz = (k: string, v: string) => setMsg((m) => ({ ...m, [k]: v }));
  const rodar = async (k: string, f: () => Promise<string>) => {
    setBusy(true);
    diz(k, 'executando…');
    try { diz(k, await f()); } catch (e: any) { diz(k, e.message); }
    setBusy(false);
  };
  const k = c?.config.chave2Captcha;
  const salvarChave = (valor: string) =>
    rodar('captcha', async () => {
      const r = await api('/coletor/2captcha', { method: 'PUT', body: { chave: valor } });
      setChave('');
      reloadC();
      return valor ? `salva · saldo US$ ${r.saldo.toFixed(2)}` : 'removida';
    });
  const ultimoBackup = s?.backups?.[0];
  const linhasEx = (ex?.arquivos ?? []).reduce((n: number, a: any) => n + a.bytes, 0);
  return (
    <div className="grid g2">
      <Card titulo="2Captcha">
        <p className="muted">{k ? <>Chave <code>••••{k.final}</code> ({k.origem === 'painel' ? 'salva aqui' : 'do .env'}). Usada no caminho “link direto”.</> : 'Sem chave: no caminho “link direto”, o captcha fica com uma pessoa no noVNC.'}</p>
        <div className="row">
          <input type="password" autoComplete="off" placeholder={k ? 'trocar chave' : 'chave da API'} value={chave} onChange={(e) => setChave(e.target.value)} />
          <button className="b" disabled={!chave.trim() || busy} onClick={() => salvarChave(chave.trim())}>Salvar</button>
          {k?.origem === 'painel' && <button className="b sec" onClick={() => salvarChave('')}>Remover</button>}
          <span className="muted">{msg.captcha}</span>
        </div>
      </Card>
      <Card titulo="Importar XML (Extrator do CNPq)">
        <p className="muted"><code>.xml</code>/<code>.zip</code> em <code>data/import</code> entram sozinhos a cada 30 s.</p>
        <div className="row">
          <button className="b sec" onClick={() => rodar('import', async () => { const r = await api('/importar-pasta', { body: {} }); return `${r.importados} importado(s)${r.falhas.length ? ' · falhas: ' + r.falhas.join(' | ') : ''}`; })}>Varrer agora</button>
          <span className="muted">{msg.import}</span>
        </div>
      </Card>
      <Card titulo="Reprocessar">
        <p className="muted">Repassa o parser em todo XML/HTML em disco (inclusive soltos em <code>data/html</code>), sem baixar nada. Use depois de atualizar o app.</p>
        <div className="row">
          <button className="b sec" onClick={() => confirm('Reprocessar TODOS os CVs em disco?') && rodar('rep', async () => `${fmt((await api('/reprocessar', { body: {} })).reenfileirados)} CV(s) na fila de parse`)}>Reprocessar todos</button>
          <span className="muted">{msg.rep}</span>
        </div>
      </Card>
      <Card titulo="Backup">
        <p className="muted">
          Último: {ultimoBackup ? `${when(ultimoBackup.em)} (${ultimoBackup.ok ? 'ok' : 'falhou'})` : 'nenhum'} · {s?.backupS3 ? <>nuvem: <code>{s.backupS3}</code></> : 'só local (defina BACKUP_S3_BUCKET para a nuvem)'}
        </p>
        <div className="row">
          <button className="b sec" disabled={busy} onClick={() => rodar('backup', async () => { const r = await api('/backup', { body: {} }); reload(); return `${r.arquivos.length} arquivo(s) → ${r.destino}`; })}>Fazer backup agora</button>
          <span className="muted">{msg.backup}</span>
        </div>
      </Card>
      <Card titulo="Cópia em Parquet">
        <p className="muted">
          Um <code>.parquet</code> por tabela, sem senha, em <code>{ex?.dir ?? 'data/exports'}</code>; roda com o backup diário.
          {ex?.arquivos.length ? <> Última: {when(ex.arquivos[0].em)} · {fmt(ex.arquivos.length)} arquivos · {fmt(Math.ceil(linhasEx / 1024))} KB.</> : ' Nenhuma ainda.'}
        </p>
        <div className="row">
          <button className="b sec" disabled={busy} onClick={() => rodar('ex', async () => { const r = await api('/exportar', { body: {} }); reloadEx(); return `${r.tabelas.length} tabelas, ${fmt(r.tabelas.reduce((n: number, t: any) => n + t.linhas, 0))} linhas`; })}>Exportar agora</button>
          <span className="muted">{msg.ex}</span>
        </div>
        {ex?.arquivos.length > 0 && (
          <details><summary className="muted">arquivos</summary>
            <table><tbody>{ex.arquivos.map((a: any) => <tr key={a.arquivo}><td>{a.arquivo}</td><td className="num">{fmt(Math.ceil(a.bytes / 1024))} KB</td></tr>)}</tbody></table>
          </details>
        )}
      </Card>
      <Card titulo="Apagar todo o banco">
        <p className="muted">
          Grava uma cópia em Parquet (<code>exports/antes-de-limpar-…</code>) e esvazia todas as tabelas. Ficam a chave do 2Captcha, o ritmo e os arquivos XML/HTML em disco.
        </p>
        <div className="row">
          <button className="b bad" disabled={busy} onClick={() => { setSenha(''); setApagando(true); }}>Apagar todo o banco…</button>
          <span className="muted">{msg.limpar}</span>
        </div>
      </Card>
      {apagando && (
        <div className="modal centro" onClick={() => !busy && setApagando(false)}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>Apagar todo o banco?</h2>
            <p>Pesquisadores, obras, autorias, orientações e a fila serão apagados. Antes, o app grava uma cópia em Parquet; se a cópia falhar, nada é apagado.</p>
            <input type="password" autoComplete="off" autoFocus placeholder="senha do banco de dados" value={senha} onChange={(e) => setSenha(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && senha && apagar()} style={{ width: '100%' }} />
            {erroApagar && <p className="err">{erroApagar}</p>}
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button className="b sec" disabled={busy} onClick={() => setApagando(false)}>Cancelar</button>
              <button className="b bad" disabled={!senha || busy} onClick={apagar}>{busy ? 'apagando…' : 'Apagar tudo'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
