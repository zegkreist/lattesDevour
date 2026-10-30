import { describe, expect, it } from 'vitest';
import { escolherUf, ufPeloNome } from '../src/util/regions.js';
import { norm } from '../src/util/text.js';

describe('UF pelo nome da instituição', () => {
  it.each([
    ['Universidade Federal de Goiás', 'GO'],
    ['Universidade Federal do Pará', 'PA'],
    ['Universidade Estadual do Paraná', 'PR'],
    ['Universidade Federal do Rio Grande do Norte', 'RN'],
    ['Universidade do Estado do Rio de Janeiro', 'RJ'],
    ['Universidade Federal de Mato Grosso do Sul', 'MS'],
    ['Universidade de Brasília', 'DF'],
    ['USP - Escola de Artes', 'SP'],
    ['UnB', 'DF'],
    ['UFG-Regional Catalão', 'GO'],
    ['Pontifícia Universidade Católica - PUC-SP', 'SP'],
    ['Faculdade Exemplo/MG', 'MG'],
  ])('%s -> %s', (nome, uf) => expect(ufPeloNome(nome)).toBe(uf));

  it.each(['Universidade Candido Mendes', 'Instituto Facuminas EAD Ltda', 'Universidade Federal de Juiz de Fora', 'Colégio O Bom Pastor'])(
    '%s -> sem palpite',
    (nome) => expect(ufPeloNome(nome)).toBeNull(),
  );

  it('escolhe o primeiro candidato com UF; a conhecida no banco vale mais que o nome', () => {
    const conhecidas = new Map([[norm('Universidade Candido Mendes'), 'RJ']]);
    expect(escolherUf(['Colégio X', 'Universidade Candido Mendes', 'Universidade Federal de Goiás'], conhecidas, norm))
      .toEqual({ uf: 'RJ', instituicao: 'Universidade Candido Mendes' });
    expect(escolherUf(['Colégio X', 'Universidade Federal de Goiás'], new Map(), norm)).toEqual({ uf: 'GO', instituicao: 'Universidade Federal de Goiás' });
    expect(escolherUf(['Colégio X'], new Map(), norm)).toBeNull();
  });
});
