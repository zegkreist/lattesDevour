import type { ReactNode } from 'react';

export const fmt = (n: number | undefined | null) => (n ?? 0).toLocaleString('pt-BR');

export function Kpi({ n, l }: { n: number | string; l: string }) {
  return <div className="card kpi"><div className="n">{typeof n === 'number' ? fmt(n) : n}</div><div className="l">{l}</div></div>;
}

export function Card({ titulo, children }: { titulo?: string; children: ReactNode }) {
  return <div className="card">{titulo && <h2>{titulo}</h2>}{children}</div>;
}

export function Progresso({ parseados, baixados, falhas, total }: { parseados: number; baixados: number; falhas: number; total: number }) {
  const pct = (v: number) => (total ? (v / total) * 100 : 0);
  return (
    <div className="bar" title={`${parseados} parseados · ${baixados - parseados} baixados · ${falhas} falhas · ${total} IDs`}>
      <i className="p" style={{ width: `${pct(parseados)}%` }} /><i className="b" style={{ width: `${pct(baixados - parseados)}%` }} /><i className="f" style={{ width: `${pct(falhas)}%` }} />
    </div>
  );
}

export const when = (s?: string | null) => (s ? new Date(s).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—');
