// Grafo em <canvas> puro com d3-force (só repulsão com Barnes-Hut + links), no mesmo molde do
// grafo do blackbook: sem lib de grafo, interação direto nos eventos do canvas (sem re-render
// por frame), seleção que fixa o grupo, arrasto que reaquece a simulação.
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type Simulation } from 'd3-force';
import { useCallback, useEffect, useMemo, useRef } from 'react';

type Orientacoes = { pos_doutorado: number; doutorado: number; mestrado: number; outras: number };
export interface GNode {
  id: string; label: string; kind: 'pesquisador' | 'obra'; grupo: string; uf?: string; instituicao?: string; ano?: number; lattesId?: string; nivel?: number;
  classe?: 'pesquisador' | 'orientador'; orientacoes?: Orientacoes;
}
export interface GEdge { a: string; b: string; w: number; tipo?: string }
interface N extends GNode { x: number; y: number; vx: number; vy: number; fx?: number | null; fy?: number | null; grau: number }
interface E { a: number; b: number; w: number; tipo?: string }

const PALETA = ['#1f6feb', '#d97706', '#059669', '#9333ea', '#dc2626', '#0891b2', '#65a30d', '#db2777', '#64748b'];
export function corDoGrupo(grupo: string, grupos: string[]): string {
  const i = grupos.indexOf(grupo);
  return i < 0 ? '#94a3b8' : PALETA[i % PALETA.length];
}
const raio = (n: N) => (n.kind === 'obra' ? 3.5 : Math.min(4 + Math.sqrt(n.grau) * 1.8, 15));
// Até onde a forma chega (o losango passa do raio): anéis, clique e colisão usam isto.
const alcance = (n: N) => (n.classe === 'orientador' ? raio(n) * 1.35 : raio(n));
// Forma = classe: obra quadrado, orientador losango, demais pesquisadores círculo.
function forma(ctx: CanvasRenderingContext2D, n: N) {
  const r = raio(n);
  if (n.kind === 'obra') ctx.rect(n.x - r, n.y - r, r * 2, r * 2);
  else if (n.classe === 'orientador') {
    const d = alcance(n);
    ctx.moveTo(n.x, n.y - d); ctx.lineTo(n.x + d, n.y); ctx.lineTo(n.x, n.y + d); ctx.lineTo(n.x - d, n.y); ctx.closePath();
  } else ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
}
const NIVEIS_ORI: [keyof Orientacoes, string][] = [['pos_doutorado', 'pós-doc'], ['doutorado', 'dout.'], ['mestrado', 'mest.'], ['outras', 'outras']];

export function Graph({ nodes, edges, onOpen }: { nodes: GNode[]; edges: GEdge[]; onOpen: (n: GNode) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const view = useRef({ scale: 1, ox: 0, oy: 0 });
  const hover = useRef<number | null>(null);
  const sel = useRef<number | null>(null);
  const drag = useRef<any>(null);
  const moved = useRef(false);
  const simRef = useRef<Simulation<N, undefined> | null>(null);
  const drawRef = useRef<() => void>(() => {});

  const grupos = useMemo(() => Array.from(new Set(nodes.map((n) => n.grupo))).sort(), [nodes]);
  const g = useMemo(() => {
    const ns: N[] = nodes.map((n) => ({ ...n, x: (Math.random() - 0.5) * 500, y: (Math.random() - 0.5) * 500, vx: 0, vy: 0, grau: 0 }));
    const idx = new Map(ns.map((n, i) => [n.id, i]));
    const es: E[] = [];
    for (const e of edges) {
      const a = idx.get(e.a), b = idx.get(e.b);
      if (a === undefined || b === undefined || a === b) continue;
      es.push({ a, b, w: e.w, tipo: e.tipo });
      ns[a].grau += e.w; ns[b].grau += e.w;
    }
    return { ns, es };
  }, [nodes, edges]);

  const vizinhos = useCallback((i: number) => {
    const s = new Set<number>([i]);
    for (const e of g.es) { if (e.a === i) s.add(e.b); if (e.b === i) s.add(e.a); }
    return s;
  }, [g]);

  const draw = useCallback(() => {
    const c = canvasRef.current; const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const { scale, ox, oy } = view.current;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(w / 2 + ox, h / 2 + oy);
    ctx.scale(scale, scale);
    const foco = sel.current ?? hover.current;
    const hi = foco !== null ? vizinhos(foco) : null;
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    for (const e of g.es) {
      const dim = hi && !(hi.has(e.a) && hi.has(e.b));
      ctx.lineWidth = Math.min(1 + Math.log2(e.w + 1) * 0.6, 4) / scale;
      ctx.strokeStyle = dim ? 'rgba(148,163,184,0.10)' : 'rgba(100,116,139,0.45)';
      ctx.setLineDash(e.tipo === 'orientacao' ? [5 / scale, 3 / scale] : []);
      ctx.beginPath(); ctx.moveTo(g.ns[e.a].x, g.ns[e.a].y); ctx.lineTo(g.ns[e.b].x, g.ns[e.b].y); ctx.stroke();
    }
    ctx.setLineDash([]);
    g.ns.forEach((n, i) => {
      ctx.globalAlpha = hi && !hi.has(i) ? 0.18 : 1;
      ctx.fillStyle = n.kind === 'obra' ? '#94a3b8' : corDoGrupo(n.grupo, grupos);
      ctx.beginPath(); forma(ctx, n); ctx.fill();
      if (n.nivel === 0 && n.kind === 'pesquisador') {
        ctx.strokeStyle = dark ? '#e6edf3' : '#1e293b'; ctx.lineWidth = 1.5 / scale;
        ctx.beginPath(); ctx.arc(n.x, n.y, alcance(n) + 2 / scale, 0, Math.PI * 2); ctx.stroke();
      }
      if (i === sel.current) {
        ctx.strokeStyle = dark ? '#e6edf3' : '#1e293b'; ctx.lineWidth = 2 / scale;
        ctx.beginPath(); ctx.arc(n.x, n.y, alcance(n) + 3 / scale, 0, Math.PI * 2); ctx.stroke();
      }
      if (hi?.has(i) || (!hi && scale > 1.8 && n.kind === 'pesquisador')) {
        ctx.globalAlpha = 1; ctx.fillStyle = dark ? '#e6edf3' : '#1e293b';
        ctx.font = `${Math.max(10, 11 / scale)}px system-ui, sans-serif`;
        ctx.fillText(n.label.length > 48 ? n.label.slice(0, 47) + '…' : n.label, n.x + alcance(n) + 3, n.y + 3);
      }
    });
    ctx.restore();
  }, [g, grupos, vizinhos]);
  drawRef.current = draw;

  useEffect(() => {
    const n = g.ns.length || 1;
    const iter = Math.max(40, Math.min(300, Math.round(50_000 / n)));
    const links = g.es.map((e) => ({ source: g.ns[e.a], target: g.ns[e.b] }));
    const sim = forceSimulation<N>(g.ns)
      .force('charge', forceManyBody().strength(-160))
      .force('link', forceLink<N, any>(links).distance(60))
      .force('collide', forceCollide<N>((d) => alcance(d) + 2))
      .force('center', forceCenter(0, 0))
      .alphaDecay(1 - Math.pow(0.001, 1 / iter))
      .on('tick', () => drawRef.current());
    simRef.current = sim;
    view.current = { scale: 1, ox: 0, oy: 0 }; sel.current = null; hover.current = null;
    return () => { sim.stop(); simRef.current = null; };
  }, [g]);

  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr; draw();
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(c);
    return () => ro.disconnect();
  }, [draw]);

  const toWorld = (cx: number, cy: number) => {
    const r = canvasRef.current!.getBoundingClientRect(); const { scale, ox, oy } = view.current;
    return { x: (cx - r.left - r.width / 2 - ox) / scale, y: (cy - r.top - r.height / 2 - oy) / scale };
  };
  const hit = (cx: number, cy: number): number | null => {
    const { x, y } = toWorld(cx, cy);
    for (let i = g.ns.length - 1; i >= 0; i--) {
      const n = g.ns[i], r = alcance(n) + 2;
      if ((n.x - x) ** 2 + (n.y - y) ** 2 <= r * r) return i;
    }
    return null;
  };
  const tip = (i: number | null, cx: number, cy: number) => {
    const t = tipRef.current; if (!t) return;
    if (i === null) { t.style.display = 'none'; return; }
    const n = g.ns[i];
    t.style.display = 'block'; t.style.left = `${cx + 12}px`; t.style.top = `${cy + 12}px`;
    t.textContent = '';
    const b = document.createElement('b'); b.textContent = n.label; t.append(b);
    const d = document.createElement('div'); d.className = 'muted';
    d.textContent = n.kind === 'obra' ? `${n.grupo}${n.ano ? ' · ' + n.ano : ''}` : [n.nivel === 0 ? 'resultado da busca' : n.nivel ? `nível ${n.nivel}` : '', n.instituicao, n.uf].filter(Boolean).join(' · ') || n.grupo;
    t.append(d);
    const o = n.orientacoes;
    if (o) {
      const od = document.createElement('div'); od.className = 'muted';
      od.textContent = 'orientador: ' + NIVEIS_ORI.filter(([k]) => o[k]).map(([k, r]) => `${o[k]} ${r}`).join(' · ');
      t.append(od);
    }
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        onPointerDown={(e) => {
          moved.current = false;
          const i = hit(e.clientX, e.clientY);
          drag.current = i !== null ? { mode: 'node', i, sx: e.clientX, sy: e.clientY } : { mode: 'pan', lx: e.clientX, ly: e.clientY, sx: e.clientX, sy: e.clientY };
          canvasRef.current?.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) { const i = hit(e.clientX, e.clientY); if (i !== hover.current) { hover.current = i; draw(); } tip(i, e.clientX, e.clientY); return; }
          if (!moved.current) {
            if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
            moved.current = true;
            if (d.mode === 'node') { const n = g.ns[d.i]; n.fx = n.x; n.fy = n.y; simRef.current?.alphaTarget(0.3).restart(); }
          }
          if (d.mode === 'pan') { view.current.ox += e.clientX - d.lx; view.current.oy += e.clientY - d.ly; d.lx = e.clientX; d.ly = e.clientY; }
          else { const p = toWorld(e.clientX, e.clientY); const n = g.ns[d.i]; n.fx = p.x; n.fy = p.y; }
          draw();
        }}
        onPointerUp={() => {
          const d = drag.current;
          if (d?.mode === 'node' && moved.current) { const n = g.ns[d.i]; n.fx = null; n.fy = null; simRef.current?.alphaTarget(0); }
          if (!moved.current) { const c = d?.mode === 'node' ? d.i : null; sel.current = c !== null && c !== sel.current ? c : null; draw(); }
          drag.current = null;
        }}
        onPointerLeave={() => { hover.current = null; tip(null, 0, 0); draw(); }}
        onDoubleClick={(e) => { const i = hit(e.clientX, e.clientY); if (i !== null) onOpen(g.ns[i]); }}
        onWheel={(e) => { view.current.scale = Math.min(8, Math.max(0.1, view.current.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1))); draw(); }}
      />
      <div ref={tipRef} className="tip" />
      <div className="legend">
        {nodes.some((n) => n.classe === 'orientador') && <><span><i className="forma" />pesquisador</span><span><i className="forma losango" />orientador</span></>}
        {edges.some((e) => e.tipo === 'orientacao') && <span><i className="tracejado" />orientação</span>}
        {grupos.map((gr) => (
          <span key={gr}>
            <i style={{ background: nodes.find((n) => n.grupo === gr)?.kind === 'obra' ? '#94a3b8' : corDoGrupo(gr, grupos) }} />
            {gr}
          </span>
        ))}
      </div>
    </>
  );
}
