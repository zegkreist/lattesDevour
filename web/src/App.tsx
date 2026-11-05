import { BookOpenText, DownloadCloud, LayoutDashboard, Menu, Search, Settings, Share2, UserSearch, X, type LucideIcon } from 'lucide-react';
import { useState, type ComponentType } from 'react';
import { usePoll } from './api';
import { Busca } from './pages/Busca';
import { Coleta } from './pages/Coleta';
import { Config } from './pages/Config';
import { GrafoPage } from './pages/GrafoPage';
import { Painel } from './pages/Painel';
import { Proximos } from './pages/Proximos';
import { Badge, faseDoColetor } from './pages/ui';

const ABAS: { k: string; nome: string; desc: string; Icone: LucideIcon; Pagina: ComponentType }[] = [
  { k: 'painel', nome: 'Painel', desc: 'Visão geral da base e dos parsers', Icone: LayoutDashboard, Pagina: Painel },
  { k: 'coleta', nome: 'Coleta', desc: 'Coletor, entrada de currículos e fila de download', Icone: DownloadCloud, Pagina: Coleta },
  { k: 'busca', nome: 'Busca', desc: 'Obras e pesquisadores já parseados', Icone: Search, Pagina: Busca },
  { k: 'grafo', nome: 'Grafo', desc: 'Rede de coautoria e orientação', Icone: Share2, Pagina: GrafoPage },
  { k: 'proximos', nome: 'Próximos', desc: 'Quem a rede cita e ainda não foi coletado', Icone: UserSearch, Pagina: Proximos },
  { k: 'config', nome: 'Configurações', desc: 'Captcha, importação, backup e manutenção do banco', Icone: Settings, Pagina: Config },
];

function StatusColetor({ onClick }: { onClick: () => void }) {
  const { data: c } = usePoll<any>('/coletor', 5000);
  if (!c) return null;
  const { tom, rotulo } = faseDoColetor(c);
  return <button className="status-link" onClick={onClick} title="Abrir a Coleta"><Badge tom={tom}>Coletor: {rotulo}</Badge></button>;
}

export function App() {
  const [aba, setAba] = useState<string>(() => location.hash.slice(1) || 'painel');
  const [menuAberto, setMenuAberto] = useState(false);
  const atual = ABAS.find((a) => a.k === aba) ?? ABAS[0];
  const ir = (k: string) => { setAba(k); location.hash = k; setMenuAberto(false); };
  return (
    <div className="shell">
      {menuAberto && <div className="scrim" onClick={() => setMenuAberto(false)} />}
      <aside className={`sidebar${menuAberto ? ' aberta' : ''}`}>
        <div className="brand">
          <div className="brand-logo"><BookOpenText size={18} /></div>
          <b>Lattes Devour</b>
          <button className="icone fechar" aria-label="Fechar menu" onClick={() => setMenuAberto(false)}><X size={16} /></button>
        </div>
        <nav className="menu">
          {ABAS.map(({ k, nome, Icone }) => (
            <button key={k} className={`item${atual.k === k ? ' on' : ''}`} aria-current={atual.k === k ? 'page' : undefined} onClick={() => ir(k)}>
              <Icone size={16} /><span>{nome}</span>
            </button>
          ))}
        </nav>
      </aside>
      <div className="content">
        <header className="topbar">
          <button className="icone abrir" aria-label="Abrir menu" onClick={() => setMenuAberto(true)}><Menu size={20} /></button>
          <div className="direita"><StatusColetor onClick={() => ir('coleta')} /></div>
        </header>
        <main>
          <div className="page" key={atual.k}>
            <div className="page-head"><h1>{atual.nome}</h1><p>{atual.desc}</p></div>
            <atual.Pagina />
          </div>
        </main>
      </div>
    </div>
  );
}
