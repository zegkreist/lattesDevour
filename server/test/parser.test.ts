import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCV } from '../src/parsers/index.js';
import { registerParser } from '../src/parsers/engine.js';
import { decodeXml } from '../src/util/xmlfile.js';

const raw = fs.readFileSync(new URL('./fixtures/cv-1111111111111111.xml', import.meta.url));
const { cv, parser } = parseCV(decodeXml(raw));

describe('parser lattes-xml-v1', () => {
  it('escolhe o parser pelo formato', () => expect(parser).toBe('lattes-xml-v1'));

  it('lê só dados profissionais (decodifica ISO-8859-1)', () => {
    expect(cv.nome).toBe('Maria da Conceição Álvares');
    expect(cv.nomesCitacao).toEqual(['ÁLVARES, M. C.', 'ALVARES, M.']);
    expect(cv.orcid).toBe('0000-0002-1825-0097');
    expect(cv.instituicao).toMatchObject({ nome: 'Universidade Federal de Minas Gerais', uf: 'MG' });
  });

  it('não carrega dado pessoal sensível', () => {
    const json = JSON.stringify(cv);
    for (const proibido of ['NAO DEVE SER LIDO', '00000000000', 'RUA SECRETA', '01011980', 'Santos']) {
      expect(json).not.toContain(proibido);
    }
  });

  it('extrai formação, atuação e áreas', () => {
    expect(cv.formacao).toHaveLength(2);
    expect(cv.formacao[1]).toMatchObject({ nivel: 'doutorado', titulo: 'Dinâmica de lagos', orientador: 'José Orientador' });
    expect(cv.atuacoes[0]).toMatchObject({ enquadramento: 'Professor Adjunto', inicio: 2010 });
    expect(cv.grandesAreas).toContain('CIENCIAS_BIOLOGICAS');
  });

  it('extrai obras de todos os tipos com a mesma lógica', () => {
    const porTipo = Object.fromEntries(cv.obras.map((o) => [o.tipo, o]));
    expect(Object.keys(porTipo).sort()).toEqual(['artigo', 'capitulo', 'evento', 'prefacio_posfacio', 'software']);
    expect(porTipo.artigo).toMatchObject({ ano: 2021, doi: '10.1000/abc.123', veiculo: 'Freshwater Biology', chave: 'doi:10.1000/abc.123' });
    expect(porTipo.artigo.autores.map((a) => a.lattesId)).toEqual(['1111111111111111', '2222222222222222', '3333333333333333']);
    expect(porTipo.evento.veiculo).toBe('Congresso Brasileiro de Limnologia');
    expect(porTipo.evento.palavrasChave).toEqual(['eutrofização', 'lagos']);
    expect(porTipo.capitulo.veiculo).toBe('Manual de águas');
    expect(porTipo.software.titulo).toBe('LagoSim');
  });

  it('extrai orientações como relação', () => {
    expect(cv.orientacoes).toHaveLength(2);
    expect(cv.orientacoes[0]).toMatchObject({ nivel: 'mestrado', orientadoNome: 'Ana Lima', orientadoLattesId: '3333333333333333', ano: 2017 });
    expect(cv.orientacoes[1]).toMatchObject({ nivel: 'outras', orientadoLattesId: null });
  });

  it('reporta elementos que nenhum parser conhece, sem quebrar', () => {
    expect(cv.desconhecidos).toContain('PRODUCAO-BIBLIOGRAFICA/SECAO-FUTURA-DO-LATTES/ITEM-NOVO');
  });

  it('rejeita formato irreconhecível; novo parser registrado passa a atender', () => {
    const outro = '<?xml version="1.0"?><CURRICULO-VITAE VERSAO="9"><IDENTIDADE nome="X"/></CURRICULO-VITAE>';
    expect(() => parseCV(outro)).toThrow(/nenhum parser reconhece/);
    registerParser({
      id: 'teste-v9',
      versao: 9,
      matches: (r) => r['@_VERSAO'] === '9',
      parse: () => ({ ...cv, nome: 'via v9' }),
    });
    expect(parseCV(outro).cv.nome).toBe('via v9');
  });
});
