import { useState } from 'react';
import { Busca } from './pages/Busca';
import { Coleta } from './pages/Coleta';
import { Config } from './pages/Config';
import { GrafoPage } from './pages/GrafoPage';
import { Painel } from './pages/Painel';
import { Proximos } from './pages/Proximos';

const ABAS = [
  ['painel', 'Painel', Painel],
  ['coleta', 'Coleta', Coleta],
  ['busca', 'Busca', Busca],
  ['grafo', 'Grafo', GrafoPage],
  ['proximos', 'Próximos', Proximos],
  ['config', 'Configurações', Config],
] as const;

export function App() {
  const [aba, setAba] = useState<string>(() => location.hash.slice(1) || 'painel');
  const Atual = ABAS.find((a) => a[0] === aba)?.[2] ?? Painel;
  return (
    <>
      <header>
        <div className="in">
          <h1>Lattes Devour</h1>
          <nav>
            {ABAS.map(([k, nome]) => (
              <button key={k} className={aba === k ? 'on' : ''} onClick={() => { setAba(k); location.hash = k; }}>{nome}</button>
            ))}
          </nav>
        </div>
      </header>
      <main><Atual /></main>
    </>
  );
}
