import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export const fmt = (n: number | undefined | null) => (n ?? 0).toLocaleString('pt-BR');

const ACENTOS: Record<string, string> = {
  apresentacao: 'apresentação', artistica: 'artística', bibliografica: 'bibliográfica', capitulo: 'capítulo', cenicas: 'cênicas', cientifico: 'científico',
  comite: 'comitê', duracao: 'duração', editoracao: 'editoração', midia: 'mídia', musica: 'música', organizacao: 'organização', posfacio: 'posfácio',
  prefacio: 'prefácio', producao: 'produção', radio: 'rádio', tecnica: 'técnica', tecnico: 'técnico', tecnologico: 'tecnológico', traducao: 'tradução',
};
/** Identificador do tipo de obra (`apresentacao_de_trabalho`) em texto para exibir. */
export const rotuloTipo = (tipo?: string | null) => (tipo ?? '').split('_').map((p) => ACENTOS[p] ?? p).join(' ');

export const when = (s?: string | null) => (s ? new Date(s).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—');

export function Kpi({ n, l, Icone, alerta }: { n: number | string; l: string; Icone: LucideIcon; alerta?: boolean }) {
  return (
    <div className={`card kpi${alerta ? ' alerta' : ''}`}>
      <div><div className="l">{l}</div><div className="n">{typeof n === 'number' ? fmt(n) : n}</div></div>
      <Icone size={20} />
    </div>
  );
}

export function Card({ titulo, desc, acao, perigo, children }: { titulo?: string; desc?: ReactNode; acao?: ReactNode; perigo?: boolean; children?: ReactNode }) {
  return (
    <div className={`card${perigo ? ' perigo' : ''}`}>
      {(titulo || acao) && (
        <div className="card-head">
          <div>{titulo && <h2>{titulo}</h2>}{desc && <p>{desc}</p>}</div>
          {acao}
        </div>
      )}
      {children && <div className="card-body">{children}</div>}
    </div>
  );
}

export type Tom = 'ok' | 'warn' | 'bad' | 'info' | 'neutro';

export function Badge({ tom, children, title }: { tom: Tom; children: ReactNode; title?: string }) {
  return <span className={`badge ${tom}`} title={title}>{children}</span>;
}

const STATUS: Record<string, [Tom, string]> = {
  pendente: ['neutro', 'pendente'],
  baixando: ['info', 'baixando'],
  aguardando_captcha: ['warn', 'aguardando captcha'],
  html: ['info', 'HTML baixado'],
  baixado: ['info', 'baixado'],
  parseado: ['ok', 'parseado'],
  erro: ['bad', 'erro'],
  sem_cv: ['bad', 'sem CV'],
};
export const statusRotulo = (s: string) => STATUS[s]?.[1] ?? s;

export function StatusBadge({ status, n }: { status: string; n?: number }) {
  return <Badge tom={STATUS[status]?.[0] ?? 'neutro'}>{statusRotulo(status)}{n !== undefined && ` ${fmt(n)}`}</Badge>;
}

export function faseDoColetor(c: { rodando: boolean; fase: string }): { tom: Tom; rotulo: string } {
  if (c.fase === 'aguardando_captcha') return { tom: 'warn', rotulo: 'aguardando captcha' };
  if (c.fase === 'pausado') return { tom: 'warn', rotulo: 'pausado' };
  return c.rodando ? { tom: 'ok', rotulo: 'rodando' } : { tom: 'neutro', rotulo: 'parado' };
}

export function Aviso({ children }: { children: ReactNode }) {
  return <div className="banner" role="status"><AlertTriangle size={16} /><div>{children}</div></div>;
}

export function Carregando() {
  return <div className="carregando"><Loader2 className="gira" size={16} /> Carregando…</div>;
}

/** Campo com rótulo em cima, como nos formulários do gestor. */
export function Campo({ rotulo, largo, title, children }: { rotulo: string; largo?: boolean; title?: string; children: ReactNode }) {
  return <label className={`campo${largo ? ' largo' : ''}`} title={title}><span>{rotulo}</span>{children}</label>;
}

export function Alternador<T extends string>({ valor, opcoes, onChange }: { valor: T; opcoes: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="group">
      {opcoes.map(([v, rotulo]) => <button key={v} className={valor === v ? 'on' : ''} aria-pressed={valor === v} onClick={() => onChange(v)}>{rotulo}</button>)}
    </div>
  );
}

export function Paginas({ page, total, set }: { page: number; total: number; set: (p: number) => void }) {
  return (
    <div className="paginas">
      <span className="muted">Página {fmt(page)} de {fmt(total)}</span>
      <button className="b sec icone-so" aria-label="Página anterior" disabled={page <= 1} onClick={() => set(page - 1)}><ChevronLeft size={16} /></button>
      <button className="b sec icone-so" aria-label="Próxima página" disabled={page >= total} onClick={() => set(page + 1)}><ChevronRight size={16} /></button>
    </div>
  );
}

/** Barras horizontais de uma série. `resto` pinta de cinza a linha que agrega o que ficou de fora. */
export function Barras({ itens }: { itens: { rotulo: string; n: number; resto?: boolean }[] }) {
  const max = Math.max(1, ...itens.map((i) => i.n));
  const total = itens.reduce((s, i) => s + i.n, 0);
  return (
    <div className="barras">
      {itens.map((i) => (
        <div className={`barra${i.resto ? ' resto' : ''}`} key={i.rotulo} title={`${i.rotulo}: ${fmt(i.n)} (${total ? Math.round((i.n / total) * 100) : 0}%)`}>
          <span className="r">{i.rotulo}</span>
          <div className="t"><i style={{ width: `${(i.n / max) * 100}%` }} /></div>
          <span className="v">{fmt(i.n)}</span>
        </div>
      ))}
    </div>
  );
}
