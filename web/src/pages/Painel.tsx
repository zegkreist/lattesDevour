import { useState } from 'react';
import { api, qs, usePoll } from '../api';
import { Card, fmt, Kpi, when } from './ui';

export function Painel() {
  const { data: s, erro, reload } = usePoll<any>('/stats', 5000);
  const [elemento, setElemento] = useState<string | null>(null);
  const [amostras, setAmostras] = useState<any[] | null>(null);
  const abrir = (path: string) => {
    if (elemento === path) return setElemento(null);
    setElemento(path);
    setAmostras(null);
    api(`/desconhecidos/cvs${qs({ elemento: path })}`).then(setAmostras);
  };
  if (erro && !s) return <p className="err">{erro}</p>;
  if (!s) return <p className="muted">Carregando…</p>;
  const f = s.fila;
  const total = Object.values<number>(f).reduce((a, b) => a + b, 0);
  const velhos = s.parsers.pesquisadoresPorVersao.filter((v: any) => v.versao < s.parsers.atual).reduce((a: number, v: any) => a + v.n, 0);
  return (
    <div className="grid">
      {f.aguardando_captcha > 0 && <div className="banner"><b>{f.aguardando_captcha} currículo(s) aguardando captcha.</b> Abra a aba Coleta para resolver.</div>}
      <div className="grid g4">
        <Kpi n={s.totais.pesquisadores} l="pesquisadores" />
        <Kpi n={s.totais.obras} l="obras" />
        <Kpi n={s.totais.orientacoes} l="orientações" />
        <Kpi n={f.pendente ?? 0} l={`na fila (de ${fmt(total)} IDs)`} />
        <Kpi n={(f.erro ?? 0) + (f.sem_cv ?? 0)} l="com erro / sem CV" />
      </div>
      <div className="grid g2">
        <Card titulo="Parsers">
          <p className="muted">{s.parsers.registrados.map((p: any) => `${p.id} v${p.versao}`).join(' · ')}</p>
          {velhos > 0 && <p><button className="b" onClick={() => api('/reprocessar', { body: {} }).then(reload)}>{fmt(velhos)} CV(s) de parser antigo: reprocessar todos</button></p>}
          <h2 style={{ marginTop: 12 }}>Elementos sem parser</h2>
          {s.desconhecidos.length === 0 ? <p className="muted">Nenhum.</p> : (
            <table><tbody>{s.desconhecidos.map((d: any) => [
              <tr key={d.path} onClick={() => abrir(d.path)} style={{ cursor: 'pointer' }} title="Ver os CVs com este elemento">
                <td>{elemento === d.path ? '▾' : '▸'} <code>{d.path}</code></td><td className="num">{fmt(d.n)} CVs</td>
              </tr>,
              elemento === d.path && (
                <tr key={d.path + ':cvs'}><td colSpan={2}>
                  {!amostras ? <span className="muted">Carregando…</span> : (
                    <>
                      <p><a href={`/api/desconhecidos/zip${qs({ elemento: d.path })}`} download>Baixar todos (.zip)</a></p>
                      <table><tbody>{amostras.map((c) => (
                        <tr key={c.id}>
                          <td>{c.nome ?? c.id}<br /><span className="muted">{c.id}</span></td>
                          <td className="num">
                            {c.arquivo ? <a href={`/api/cv/${c.id}/arquivo`} download>baixar .{c.arquivo}</a> : <span className="muted">sem arquivo</span>}
                            {' · '}<a href={`http://lattes.cnpq.br/${c.id}`} target="_blank" rel="noreferrer">Lattes</a>
                          </td>
                        </tr>
                      ))}</tbody></table>
                    </>
                  )}
                </td></tr>
              ),
            ])}</tbody></table>
          )}
          {s.desconhecidos.length > 0 && <p className="muted">Clique para ver e baixar os CVs (amostras).</p>}
        </Card>
        <Card titulo="Obras por tipo">
          <table><tbody>
            {s.obrasPorTipo.slice(0, 10).map((t: any) => <tr key={t.tipo}><td>{t.tipo.replaceAll('_', ' ')}</td><td className="num">{fmt(t.n)}</td></tr>)}
            {s.obrasPorTipo.length > 10 && <tr><td className="muted">outros {s.obrasPorTipo.length - 10} tipos</td><td className="num muted">{fmt(s.obrasPorTipo.slice(10).reduce((n: number, t: any) => n + t.n, 0))}</td></tr>}
          </tbody></table>
        </Card>
        <Card titulo="Pesquisadores por região">
          <table><tbody>{s.pesquisadoresPorRegiao.map((t: any) => <tr key={t.regiao}><td>{t.regiao}</td><td className="num">{fmt(t.n)}</td></tr>)}</tbody></table>
        </Card>
        {s.erros.length > 0 && (
          <Card titulo="Últimos erros">
            <table><tbody>{s.erros.map((e: any) => <tr key={e.lattes_id + e.atualizado_em}><td>{e.lattes_id}</td><td className="err">{e.ultimo_erro}</td><td>{when(e.atualizado_em)}</td></tr>)}</tbody></table>
          </Card>
        )}
      </div>
    </div>
  );
}
