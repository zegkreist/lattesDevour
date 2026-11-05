import { useEffect, useState } from 'react';
import { api, qs } from '../api';
import { Graph, type GNode } from '../Graph';
import { Filtros, FILTRO_VAZIO, type Filtro } from './Filtros';
import { PerfilModal } from './PerfilModal';
import { Alternador, Campo, Card, Carregando, fmt } from './ui';

const MODOS = [['colab', 'Colaboradores'], ['obras', 'Pesquisadores e obras']] as const;

export function GrafoPage() {
  const [f, setF] = useState<Filtro>(FILTRO_VAZIO);
  const [modo, setModo] = useState<'colab' | 'obras'>('colab');
  const [limit, setLimit] = useState(300);
  const [niveis, setNiveis] = useState(2);
  const [sementes, setSementes] = useState(30);
  const [g, setG] = useState<{ nodes: any[]; edges: any[] } | null>(null);
  const [perfil, setPerfil] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => { setG(null); api(`/graph${qs({ ...f, modo, limit, niveis, sementes })}`).then(setG).catch(() => setG({ nodes: [], edges: [] })); }, 350);
    return () => clearTimeout(t);
  }, [f, modo, limit, niveis, sementes]);
  return (
    <div className="grid">
      <Card>
        <div className="row entre">
          <Alternador valor={modo} opcoes={MODOS} onChange={setModo} />
          {g && <span className="muted">{fmt(g.nodes.length)} nós · {fmt(g.edges.length)} {g.edges.length === 1 ? 'ligação' : 'ligações'}</span>}
        </div>
        <Filtros f={f} set={setF} mostrar={['q', 'regiao', 'uf', 'inst', 'tema']}>
          <Campo rotulo="Alcance da rede" title="Saltos de coautoria/orientação a partir do resultado da busca">
            <select value={niveis} onChange={(e) => setNiveis(Number(e.target.value))}>
              {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n === 0 ? 'Só o filtro' : `${n} nível${n > 1 ? 'is' : ''}`}</option>)}
            </select>
          </Campo>
          {niveis > 0 && (
            <Campo rotulo="Pontos de partida" title="Quantos resultados da busca viram ponto de partida">
              <select value={sementes} onChange={(e) => setSementes(Number(e.target.value))}>
                {[1, 5, 10, 30, 100].map((n) => <option key={n} value={n}>Até {n} resultado{n > 1 ? 's' : ''}</option>)}
              </select>
            </Campo>
          )}
          <Campo rotulo="Máximo de nós">
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>{[100, 300, 600, 1000, 2000].map((n) => <option key={n} value={n}>{fmt(n)}</option>)}</select>
          </Campo>
        </Filtros>
      </Card>
      <div className="card graphbox">
        {!g ? <div style={{ padding: '4px 24px' }}><Carregando /></div>
          : g.nodes.length === 0 ? <p className="muted" style={{ padding: 24 }}>Sem dados para este filtro. O grafo só liga pesquisadores já parseados.</p>
          : <Graph nodes={g.nodes} edges={g.edges} onOpen={(n: GNode) => n.lattesId && setPerfil(n.lattesId)} />}
      </div>
      <p className="muted" style={{ margin: 0 }}>Arraste para mover, roda do mouse para zoom. Clique num ponto para fixar o grupo dele; duplo clique abre o perfil. O filtro define os pontos de partida (anel escuro); a rede cresce a partir deles. Cor = região; quadrado cinza = obra; losango = orientador (tem orientações no CV). Linha tracejada = orientação. Espessura = nº de obras em comum.</p>
      {perfil && <PerfilModal id={perfil} onClose={() => setPerfil(null)} onOpen={setPerfil} />}
    </div>
  );
}
