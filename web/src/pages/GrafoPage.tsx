import { useEffect, useState } from 'react';
import { api, qs } from '../api';
import { Graph, type GNode } from '../Graph';
import { Filtros, FILTRO_VAZIO, type Filtro } from './Filtros';
import { PerfilModal } from './PerfilModal';
import { Card, fmt } from './ui';

export function GrafoPage() {
  const [f, setF] = useState<Filtro>(FILTRO_VAZIO);
  const [modo, setModo] = useState<'colab' | 'obras'>('colab');
  const [limit, setLimit] = useState(300);
  const [g, setG] = useState<{ nodes: any[]; edges: any[] } | null>(null);
  const [perfil, setPerfil] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => { setG(null); api(`/graph${qs({ ...f, modo, limit })}`).then(setG).catch(() => setG({ nodes: [], edges: [] })); }, 350);
    return () => clearTimeout(t);
  }, [f, modo, limit]);
  return (
    <div className="grid">
      <Card>
        <div className="row" style={{ marginBottom: 10 }}>
          <button className={`b ${modo === 'colab' ? '' : 'sec'}`} onClick={() => setModo('colab')}>Colaboradores</button>
          <button className={`b ${modo === 'obras' ? '' : 'sec'}`} onClick={() => setModo('obras')}>Pesquisadores e obras</button>
          <span className="muted">máx. nós:</span>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>{[100, 300, 600, 1000, 2000].map((n) => <option key={n}>{n}</option>)}</select>
          {g && <span className="muted">{fmt(g.nodes.length)} nós · {fmt(g.edges.length)} ligações</span>}
        </div>
        <Filtros f={f} set={setF} mostrar={['q', 'regiao', 'uf', 'inst', 'tema']} />
      </Card>
      <div className="card graphbox">
        {!g ? <p className="muted" style={{ padding: 20 }}>Carregando…</p>
          : g.nodes.length === 0 ? <p className="muted" style={{ padding: 20 }}>Sem dados para este filtro. O grafo só liga pesquisadores já parseados.</p>
          : <Graph nodes={g.nodes} edges={g.edges} onOpen={(n: GNode) => n.lattesId && setPerfil(n.lattesId)} />}
      </div>
      <p className="muted">Arraste para mover, roda do mouse para zoom. Clique num ponto para fixar o grupo dele; duplo clique abre o perfil. Cor = região (pesquisadores) ou tipo (obras). Espessura = nº de obras em comum.</p>
      {perfil && <PerfilModal id={perfil} onClose={() => setPerfil(null)} onOpen={setPerfil} />}
    </div>
  );
}
