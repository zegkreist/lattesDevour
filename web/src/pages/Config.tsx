import { DatabaseBackup, Download, FileDown, RefreshCw, Save, Trash2, Upload } from 'lucide-react';
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
  const [zip, setZip] = useState<File | null>(null);
  const [campoZip, setCampoZip] = useState(0); // trocar a key limpa o campo de arquivo depois de importar
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
  const importar = () =>
    rodar('import', async () => {
      const r = await fetch('/api/importar', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zip });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.erro ?? (r.status === 413 ? 'arquivo maior que o limite de 1 GB' : `HTTP ${r.status}`));
      setZip(null);
      setCampoZip((n) => n + 1);
      reload();
      return `${fmt(j.cvsNovos)} CV(s) novos · ${fmt(j.cvsAtualizados)} atualizados · ${fmt(j.cvsMantidos)} mantidos · ${fmt(j.obrasNovas)} obras novas · ${fmt(j.naFila)} pendentes na fila`;
    });
  const ultimoBackup = s?.backups?.[0];
  const linhasEx = (ex?.arquivos ?? []).reduce((n: number, a: any) => n + a.bytes, 0);
  return (
    <div className="grid g2 uniforme">
      <Card titulo="2Captcha" desc={k ? <>Chave <code>••••{k.final}</code> ({k.origem === 'painel' ? 'salva aqui' : 'do .env'}). Usada no caminho “link direto”.</> : 'Sem chave: no caminho “link direto”, o captcha fica com uma pessoa no noVNC.'}>
        <div className="row">
          <input type="password" autoComplete="off" aria-label="Chave da API do 2Captcha" placeholder={k ? 'Trocar chave' : 'Chave da API'} value={chave} onChange={(e) => setChave(e.target.value)} />
          <button className="b" disabled={!chave.trim() || busy} onClick={() => salvarChave(chave.trim())}><Save size={14} /> Salvar</button>
          {k?.origem === 'painel' && <button className="b sec" onClick={() => salvarChave('')}>Remover</button>}
          {msg.captcha && <span className="muted">{msg.captcha}</span>}
        </div>
      </Card>
      <Card titulo="Importar base" desc="Recebe o .zip baixado em “Cópia em Parquet” de outro Lattes Devour. CV nas duas bases fica na versão mais recente; se a data empatar, na maior. Os arquivos crus não vêm junto, então “Reprocessar todos” não alcança o CV importado.">
        <div className="row">
          <input key={campoZip} type="file" accept=".zip,application/zip" aria-label="Arquivo .zip da exportação" disabled={busy} onChange={(e) => setZip(e.target.files?.[0] ?? null)} />
          <button className="b" disabled={!zip || busy} onClick={importar}><Upload size={14} /> Importar</button>
          {msg.import && <span className="muted">{msg.import}</span>}
        </div>
      </Card>
      <Card titulo="Reprocessar" desc={<>Repassa o parser em todo XML/HTML em disco (inclusive soltos em <code>data/html</code>), sem baixar nada. Use depois de atualizar o app.</>}>
        <div className="row">
          <button className="b sec" onClick={() => confirm('Reprocessar TODOS os CVs em disco?') && rodar('rep', async () => `${fmt((await api('/reprocessar', { body: {} })).reenfileirados)} CV(s) na fila de parse`)}><RefreshCw size={14} /> Reprocessar todos</button>
          {msg.rep && <span className="muted">{msg.rep}</span>}
        </div>
      </Card>
      <Card titulo="Backup" desc={<>Último: {ultimoBackup ? `${when(ultimoBackup.em)} (${ultimoBackup.ok ? 'ok' : 'falhou'})` : 'nenhum'} · {s?.backupS3 ? <>nuvem: <code>{s.backupS3}</code></> : 'só local (defina BACKUP_S3_BUCKET para a nuvem)'}</>}>
        <div className="row">
          <button className="b sec" disabled={busy} onClick={() => rodar('backup', async () => { const r = await api('/backup', { body: {} }); reload(); return `${r.arquivos.length} arquivo(s) → ${r.destino}`; })}><DatabaseBackup size={14} /> Fazer backup agora</button>
          {msg.backup && <span className="muted">{msg.backup}</span>}
        </div>
      </Card>
      <Card titulo="Cópia em Parquet" desc={<>
        Um <code>.parquet</code> por tabela, sem senha, em <code>{ex?.dir ?? 'data/exports'}</code>; roda com o backup diário.
        {ex?.arquivos.length ? <> Última: {when(ex.arquivos[0].em)} · {fmt(ex.arquivos.length)} arquivos · {fmt(Math.ceil(linhasEx / 1024))} KB.</> : ' Nenhuma ainda.'}
      </>}>
        <div className="row">
          <button className="b sec" disabled={busy} onClick={() => rodar('ex', async () => { const r = await api('/exportar', { body: {} }); reloadEx(); return `${r.tabelas.length} tabelas, ${fmt(r.tabelas.reduce((n: number, t: any) => n + t.linhas, 0))} linhas`; })}><FileDown size={14} /> Exportar agora</button>
          {ex?.arquivos.length > 0 && <a className="b sec" href="/api/exportar/zip" download style={{ textDecoration: 'none' }}><Download size={14} /> Baixar .zip</a>}
          {msg.ex && <span className="muted">{msg.ex}</span>}
        </div>
        {ex?.arquivos.length > 0 && (
          <details><summary className="muted">Arquivos</summary>
            <div className="tw" style={{ marginTop: 8 }}><table><tbody>{ex.arquivos.map((a: any) => <tr key={a.arquivo}><td>{a.arquivo}</td><td className="num">{fmt(Math.ceil(a.bytes / 1024))} KB</td></tr>)}</tbody></table></div>
          </details>
        )}
      </Card>
      <Card perigo titulo="Apagar todo o banco" desc={<>Grava uma cópia em Parquet (<code>exports/antes-de-limpar-…</code>) e esvazia todas as tabelas. Ficam a chave do 2Captcha, o ritmo e os arquivos XML/HTML em disco.</>}>
        <div className="row">
          <button className="b bad" disabled={busy} onClick={() => { setSenha(''); setApagando(true); }}><Trash2 size={14} /> Apagar todo o banco…</button>
          {msg.limpar && <span className="muted">{msg.limpar}</span>}
        </div>
      </Card>
      {apagando && (
        <div className="modal centro" onClick={() => !busy && setApagando(false)}>
          <div className="panel" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h2>Apagar todo o banco?</h2>
            <p>Pesquisadores, obras, autorias, orientações e a fila serão apagados. Antes, o app grava uma cópia em Parquet; se a cópia falhar, nada é apagado.</p>
            <input type="password" autoComplete="off" autoFocus aria-label="Senha do banco de dados" placeholder="Senha do banco de dados" value={senha} onChange={(e) => setSenha(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && senha && apagar()} style={{ width: '100%' }} />
            {erroApagar && <p className="err">{erroApagar}</p>}
            <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
              <button className="b sec" disabled={busy} onClick={() => setApagando(false)}>Cancelar</button>
              <button className="b bad" disabled={!senha || busy} onClick={apagar}>{busy ? 'Apagando…' : 'Apagar tudo'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
