import { toInt } from '../../util/text.js';
import { arr, attrs, children } from '../helpers.js';
import { collect } from './producao.js';
import type { Node, ParsedOrientacao, SectionParser } from '../types.js';

const NIVEL: [string, ParsedOrientacao['nivel']][] = [
  ['POS-DOUTORADO', 'pos_doutorado'],
  ['DOUTORADO', 'doutorado'],
  ['MESTRADO', 'mestrado'],
  ['OUTRAS', 'outras'],
];

function nivelDe(name: string): ParsedOrientacao['nivel'] {
  return NIVEL.find(([k]) => name.includes(k))?.[1] ?? 'outras';
}

// OUTRA-PRODUCAO = orientações concluídas + produção artística + demais trabalhos.
// Orientações viram relação orientador→orientado (aresta do grafo); o resto cai no coletor
// genérico de obras.
export const outraProducao: SectionParser = {
  name: 'outra-producao',
  element: 'OUTRA-PRODUCAO',
  parse(node: Node, ctx) {
    for (const [name, child] of children(node)) {
      if (name === 'ORIENTACOES-CONCLUIDAS') {
        for (const [grupo, item] of children(child)) {
          const nivel = nivelDe(grupo);
          const basKey = Object.keys(item).find((k) => k.startsWith('DADOS-BASICOS-'));
          const detKey = Object.keys(item).find((k) => k.startsWith('DETALHAMENTO-'));
          const b = attrs(basKey ? arr(item[basKey])[0] : undefined);
          const d = attrs(detKey ? arr(item[detKey])[0] : undefined);
          const nome = d['NOME-DO-ORIENTADO'];
          if (!nome) {
            ctx.warn(`orientação sem orientado em ${grupo}`);
            continue;
          }
          const id = d['NUMERO-ID-ORIENTADO'];
          ctx.cv.orientacoes.push({
            nivel,
            orientadoNome: nome,
            orientadoLattesId: id && /^\d{16}$/.test(id) ? id : null,
            titulo: b['TITULO'] ?? null,
            ano: toInt(b['ANO']),
            instituicao: d['NOME-DA-INSTITUICAO'] ?? null,
            curso: d['NOME-DO-CURSO'] ?? null,
          });
        }
      } else {
        collect({ [name]: child }, 'OUTRA-PRODUCAO', ctx);
      }
    }
  },
};
