import { AlertCircle, BookOpen, ChevronDown, ChevronRight, Download, GraduationCap, ListOrdered, RefreshCw, Users } from 'lucide-react';
import { useState } from 'react';
import { api, qs, usePoll } from '../api';
import { Aviso, Barras, Card, Carregando, fmt, Kpi, rotuloTipo, when } from './ui';

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
  if (!s) return <Carregando />;
  const f = s.fila;
  const total = Object.values<number>(f).reduce((a, b) => a + b, 0);
  const velhos = s.parsers.pesquisadoresPorVersao.filter((v: any) => v.versao < s.parsers.atual).reduce((a: number, v: any) => a + v.n, 0);
  const comProblema = (f.erro ?? 0) + (f.sem_cv ?? 0);
  const tipos = s.obrasPorTipo.slice(0, 10).map((t: any) => ({ rotulo: rotuloTipo(t.tipo), n: t.n }));
  if (s.obrasPorTipo.length > 10) tipos.push({ rotulo: `Outros ${s.obrasPorTipo.length - 10} tipos`, n: s.obrasPorTipo.slice(10).reduce((n: number, t: any) => n + t.n, 0), resto: true });
  return (
    <div className="grid">
      {f.aguardando_captcha > 0 && <Aviso><b>{f.aguardando_captcha} currículo(s) aguardando captcha.</b> Abra a aba Coleta para resolver.</Aviso>}
      <div className="grid g4">
        <Kpi n={s.totais.pesquisadores} l="Pesquisadores" Icone={Users} />
        <Kpi n={s.totais.obras} l="Obras" Icone={BookOpen} />
        <Kpi n={s.totais.orientacoes} l="Orientações" Icone={GraduationCap} />
        <Kpi n={f.pendente ?? 0} l={`Na fila (de ${fmt(total)} IDs)`} Icone={ListOrdered} />
        <Kpi n={comProblema} l="Com erro / sem CV" Icone={AlertCircle} alerta={comProblema > 0} />
      </div>
      <div className="grid g2">
        <Card titulo="Obras por tipo"><Barras itens={tipos} /></Card>
        <Card titulo="Pesquisadores por região">
          {s.pesquisadoresPorRegiao.length === 0 ? <p className="muted">Nenhum ainda.</p> : <Barras itens={s.pesquisadoresPorRegiao.map((t: any) => ({ rotulo: t.regiao, n: t.n }))} />}
        </Card>
        <Card titulo="Elementos sem parser" desc={s.desconhecidos.length > 0 ? 'Clique para ver e baixar os CVs (amostras).' : undefined}>
          {s.desconhecidos.length === 0 ? <p className="muted">Nenhum.</p> : (
            <div className="tw"><table><tbody>{s.desconhecidos.map((d: any) => [
              <tr key={d.path} className="clicavel" onClick={() => abrir(d.path)} title="Ver os CVs com este elemento">
                <td><div className="celula-lista">{elemento === d.path ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<code>{d.path}</code></div></td><td className="num">{fmt(d.n)} CVs</td>
              </tr>,
              elemento === d.path && (
                <tr key={d.path + ':cvs'}><td colSpan={2}>
                  {!amostras ? <Carregando /> : (
                    <>
                      <p style={{ margin: '4px 0 12px' }}><a className="b sec peq" href={`/api/desconhecidos/zip${qs({ elemento: d.path })}`} download style={{ textDecoration: 'none' }}><Download size={14} /> Baixar todos (.zip)</a></p>
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
            ])}</tbody></table></div>
          )}
        </Card>
        <Card titulo="Parsers">
          <div>{s.parsers.registrados.map((p: any) => <span className="tag" key={p.id}>{p.id} v{p.versao}</span>)}</div>
          {velhos > 0 && <button className="b" onClick={() => api('/reprocessar', { body: {} }).then(reload)}><RefreshCw size={14} /> {fmt(velhos)} CV(s) de parser antigo: reprocessar todos</button>}
        </Card>
        {s.erros.length > 0 && (
          <Card titulo="Últimos erros">
            <div className="tw"><table><tbody>{s.erros.map((e: any) => <tr key={e.lattes_id + e.atualizado_em}><td>{e.lattes_id}</td><td className="err">{e.ultimo_erro}</td><td>{when(e.atualizado_em)}</td></tr>)}</tbody></table></div>
          </Card>
        )}
      </div>
    </div>
  );
}
