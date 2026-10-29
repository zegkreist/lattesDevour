import { api, usePoll } from '../api';
import { Card, fmt, Kpi, when } from './ui';

export function Painel() {
  const { data: s, erro, reload } = usePoll<any>('/stats', 5000);
  if (erro && !s) return <p className="err">{erro}</p>;
  if (!s) return <p className="muted">Carregando…</p>;
  const f = s.fila;
  const total = Object.values<number>(f).reduce((a, b) => a + b, 0);
  const velhos = s.parsers.pesquisadoresPorVersao.filter((v: any) => v.versao < s.parsers.atual).reduce((a: number, v: any) => a + v.n, 0);
  return (
    <div className="grid">
      {f.aguardando_captcha > 0 && <div className="banner"><b>{f.aguardando_captcha} currículo(s) aguardando captcha.</b> Abra a aba Coleta para resolver.</div>}
      <div className="grid g4">
        <Kpi n={s.totais.pesquisadores} l="pesquisadores parseados" />
        <Kpi n={s.totais.obras} l="obras (deduplicadas)" />
        <Kpi n={s.totais.autorias} l="autorias" />
        <Kpi n={s.totais.orientacoes} l="orientações" />
        <Kpi n={f.pendente ?? 0} l="IDs na fila de download" />
        <Kpi n={(f.baixado ?? 0)} l="baixados, a parsear" />
        <Kpi n={(f.erro ?? 0) + (f.sem_cv ?? 0)} l="com erro / sem CV" />
        <Kpi n={total} l="IDs conhecidos" />
      </div>
      <div className="grid g2">
        <Card titulo="Parsers">
          <p className="muted">Registrados: {s.parsers.registrados.map((p: any) => `${p.id} (v${p.versao})`).join(', ')}</p>
          <table><tbody>
            {s.parsers.pesquisadoresPorVersao.map((v: any) => <tr key={v.versao}><td>versão {v.versao}</td><td className="num">{fmt(v.n)} CVs</td></tr>)}
          </tbody></table>
          {velhos > 0 && <p><button className="b" onClick={() => api('/reprocessar', { body: {} }).then(reload)}>Reprocessar {fmt(velhos)} CV(s) de parser antigo</button></p>}
          <h2 style={{ marginTop: 16 }}>Elementos sem parser</h2>
          {s.desconhecidos.length === 0 ? <p className="muted">Nenhum. O formato atual está coberto.</p> : (
            <table><tbody>{s.desconhecidos.map((d: any) => <tr key={d.path}><td><code>{d.path}</code></td><td className="num">{fmt(d.n)} CVs</td></tr>)}</tbody></table>
          )}
          {s.desconhecidos.length > 0 && <p className="muted">Se for um tipo/formato novo, adicione um parser (README → “Adicionar um parser”) e reprocese.</p>}
        </Card>
        <Card titulo="Obras por tipo">
          <table><tbody>{s.obrasPorTipo.map((t: any) => <tr key={t.tipo}><td>{t.tipo}</td><td className="num">{fmt(t.n)}</td></tr>)}</tbody></table>
        </Card>
        <Card titulo="Pesquisadores por região">
          <table><tbody>{s.pesquisadoresPorRegiao.map((t: any) => <tr key={t.regiao}><td>{t.regiao}</td><td className="num">{fmt(t.n)}</td></tr>)}</tbody></table>
        </Card>
        <Card titulo="Últimos erros">
          {s.erros.length === 0 ? <p className="muted">Sem erros.</p> : (
            <table><tbody>{s.erros.map((e: any) => <tr key={e.lattes_id + e.atualizado_em}><td>{e.lattes_id}</td><td className="err">{e.ultimo_erro}</td><td>{when(e.atualizado_em)}</td></tr>)}</tbody></table>
          )}
        </Card>
        <Card titulo="Backups">
          <p className="muted">{s.backupS3 ? `Nuvem: ${s.backupS3}` : 'Nuvem não configurada (só local em data/backups). Defina BACKUP_S3_BUCKET.'}</p>
          <table><tbody>{s.backups.map((b: any) => <tr key={b.em + b.arquivo}><td>{when(b.em)}</td><td>{b.arquivo}</td><td className={b.ok ? 'st-parseado' : 'err'}>{b.ok ? 'ok' : b.erro}</td></tr>)}</tbody></table>
        </Card>
      </div>
    </div>
  );
}
