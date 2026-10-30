import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseHtmlCV } from '../src/parsers/index.js';

const html = fs.readFileSync(new URL('./fixtures/cv-html-sintetico.html', import.meta.url), 'utf8');
const cv = parseHtmlCV(html);
const obra = (tipo: string) => cv.obras.filter((o) => o.tipo === tipo);

describe('parser lattes-html-v1', () => {
  it('cabeçalho e identificação', () => {
    expect(cv.lattesId).toBe('1234567890123456');
    expect(cv.nome).toBe('Ana Fictícia Souza');
    expect(cv.nomesCitacao).toEqual(['SOUZA, A. F.', 'SOUZA, ANA FICTÍCIA']);
    expect(cv.orcid).toBe('0000-0002-1825-0097');
    expect(cv.dataAtualizacao).toBe('2026-03-05');
    expect(cv.resumo).toBe('Professora de literatura comparada.');
  });

  it('endereço profissional dá instituição e UF', () => {
    expect(cv.instituicao).toEqual({ codigo: null, nome: 'Universidade Federal Fictícia', uf: 'GO', cidade: 'Goiânia', pais: 'Brasil' });
    expect(cv.avisos).not.toContain('sem endereço profissional');
  });

  it('formação, atuação e áreas', () => {
    expect(cv.formacao).toHaveLength(4);
    // Bloco próprio "Pós-doutorado" também é formação, como no XML.
    expect(cv.formacao[3]).toMatchObject({ nivel: 'pos_doutorado', instituicao: 'Universidade Federal do Ceará', inicio: 2019, fim: 2021 });
    expect(cv.formacao[2]).toMatchObject({ nivel: 'ensino_fundamental_primeiro_grau', instituicao: 'Escola Estadual Modelo', inicio: 1998, fim: 2005 });
    expect(cv.formacao[0]).toMatchObject({ nivel: 'pos_doutorado', instituicao: 'Universidade de Lisboa', inicio: 2023, fim: null });
    expect(cv.formacao[1]).toMatchObject({
      nivel: 'doutorado', curso: 'Letras', inicio: 2014, fim: 2018, titulo: 'Cidades de papel', orientador: 'Bruno Inventado Lima',
    });
    // Um registro por instituição, com o vínculo mais recente.
    expect(cv.atuacoes).toEqual([
      { instituicao: 'Universidade Federal Fictícia', vinculo: 'Servidor Público', enquadramento: 'Professor Adjunto', inicio: 2019, fim: null },
    ]);
    expect(cv.grandesAreas).toEqual(['Lingüística, Letras e Artes']);
    expect(cv.areas).toEqual(['Letras']);
  });

  it('artigo: título do texto, metadados do cvuri (mesmo com "?" no título)', () => {
    const [a] = obra('artigo');
    expect(a).toMatchObject({
      titulo: 'Leituras de "Sant\'Anna": ensaio', ano: 2024, doi: '10.1234/abc.2024.1', chave: 'doi:10.1234/abc.2024.1',
      veiculo: 'REVISTA FICTÍCIA DE LETRAS', issn: '12345678',
    });
    expect(a.autores.map((x) => x.nome)).toEqual(['SOUZA, A. F.', 'LIMA, B. I.']);
    expect(a.dados).toMatchObject({
      'TITULO-DO-PERIODICO-OU-REVISTA': 'REVISTA FICTÍCIA DE LETRAS', ISSN: '12345678', VOLUME: '7',
      'PAGINA-INICIAL': '1', 'PAGINA-FINAL': '20', 'ANO-DO-ARTIGO': '2024',
    });
    expect(a.dados.CITACAO).toMatch(/^SOUZA, A\. F\.; LIMA/);
  });

  it('detalhes da citação com os nomes de atributo do XML', () => {
    expect(obra('capitulo')[0].dados).toMatchObject({
      ORGANIZADORES: 'Carla Exemplo', 'TITULO-DO-LIVRO': 'Estudos de ficção', 'NUMERO-DA-EDICAO-REVISAO': '1',
      'CIDADE-DA-EDITORA': 'Goiânia', 'NOME-DA-EDITORA': 'Editora X', VOLUME: '1', 'PAGINA-INICIAL': '10', 'PAGINA-FINAL': '30',
    });
    const ev = obra('evento')[0].dados;
    expect(ev).toMatchObject({
      NATUREZA: 'RESUMO', 'NOME-DO-EVENTO': 'III Colóquio de Letras', 'ANO-DE-REALIZACAO': '2022',
      'CIDADE-DO-EVENTO': 'Goiânia', 'TITULO-DOS-ANAIS-OU-PROCEEDINGS': 'Caderno de Resumos',
    });
    // Título com dois-pontos/anais sem editora não vira "cidade: editora".
    expect(ev['CIDADE-DA-EDITORA']).toBeUndefined();
    expect(obra('apresentacao_de_trabalho')[0].dados).toMatchObject({ NATUREZA: 'COMUNICACAO', ANO: '2022' });
  });

  it('capítulo, resumo em anais, apresentação e organização: mesmos tipos e chave do XML', () => {
    const [c] = obra('capitulo');
    expect(c).toMatchObject({ titulo: 'O romance e a cidade', ano: 2021, veiculo: 'Estudos de ficção', chave: 'capitulo|o romance e a cidade|2021' });
    expect(c.autores.map((x) => x.nome)).toEqual(['LIMA, B. I.', 'SOUZA, A. F.']);
    // Coautor com link para o Lattes já sai com o ID (aresta do grafo antes de coletar o CV dele).
    expect(c.autores.map((x) => x.lattesId)).toEqual(['6543210987654321', null]);
    const [r] = obra('evento');
    expect(r).toMatchObject({ titulo: 'Memória e paisagem (1950-1952)', ano: 2022, subtipo: 'RESUMO', veiculo: 'III Colóquio de Letras' });
    const [ap] = obra('apresentacao_de_trabalho');
    expect(ap).toMatchObject({ titulo: 'Memória e paisagem', ano: 2022, subtipo: 'COMUNICACAO' });
    const [org] = obra('organizacao_de_evento');
    expect(org).toMatchObject({ titulo: 'III Colóquio de Letras', ano: 2022 });
    // Participação em eventos fica de fora, como no XML.
    expect(cv.obras).toHaveLength(9);
    // Dona do CV citada pelo nome completo, sem vírgula.
    const ap3 = obra('apresentacao_de_trabalho')[2];
    expect(ap3).toMatchObject({ titulo: 'Arte e política', ano: 2025 });
    expect(ap3.autores.map((x) => x.nome)).toEqual(['ANA FICTÍCIA SOUZA']);
    // Prenome por extenso com ponto ("MODELO, Elisa.;") ainda é autor.
    const [, ap2] = obra('apresentacao_de_trabalho');
    expect(ap2).toMatchObject({ titulo: 'Fotografia e sertão', subtipo: 'CONFERENCIA_OU_PALESTRA' });
    expect(ap2.autores.map((x) => x.nome)).toEqual(['MODELO, Elisa.', 'SOUZA, A. F.']);
  });

  it('listas mistas: o tipo vem do parêntese (nome do elemento no XML); autores fora do padrão', () => {
    const [t] = obra('traducao');
    expect(t).toMatchObject({ titulo: 'Ensaios traduzidos', ano: 2020, subtipo: 'LIVRO' });
    // Nome por extenso e "(Org.)" na lista de autores.
    expect(t.autores.map((x) => x.nome)).toEqual(['SOUZA, ANA FICTÍCIA', 'MODELO, Elisa']);
    const [c] = obra('curso_de_curta_duracao_ministrado');
    expect(c).toMatchObject({ titulo: 'Oficina de escrita', ano: 2021, subtipo: 'EXTENSAO' });
    // Autor só com sobrenome: a lista vai até o " . ".
    expect(c.autores.map((x) => x.nome)).toEqual(['PEREIRA', 'SOUZA, A. F.']);
  });

  it('orientações: só as concluídas, com nível, curso, instituição e ID do orientado', () => {
    expect(cv.orientacoes).toEqual([
      {
        nivel: 'mestrado', orientadoNome: 'Daniel Teste Rocha', orientadoLattesId: '1111222233334444', titulo: 'A cidade no romance',
        ano: 2023, instituicao: 'Universidade Federal Fictícia', curso: 'Mestrado em Letras - Estudos Literários',
      },
      {
        nivel: 'outras', orientadoNome: 'ELISA MODELO', orientadoLattesId: null, titulo: 'Poesia e horror',
        ano: 2021, instituicao: 'Universidade Federal Fictícia', curso: 'Graduando em Letras - Português',
      },
    ]);
  });

  it('pesquisadores com link para o Lattes viram vinculados (sem o dono)', () => {
    expect(cv.vinculados).toEqual([
      { lattesId: '6543210987654321', nome: 'Bruno Inventado Lima' },
      { lattesId: '1111222233334444', nome: 'Daniel Teste Rocha' },
    ]);
  });

  it('seção nova aparece em desconhecidos; as conhecidas não', () => {
    expect(cv.desconhecidos).toEqual(['html:secao nova do lattes']);
  });

  it('página sem ID Lattes é erro, não CV vazio', () => {
    expect(() => parseHtmlCV('<html><body><div class="infpessoa"><h2 class="nome">X</h2></div></body></html>')).toThrow(/ID Lattes/);
  });
});

// Amostras reais (fora do git, em data/amostras/): só rodam se existirem.
const pastaAmostras = new URL('../../data/amostras/', import.meta.url);
const amostras = fs.existsSync(pastaAmostras) ? fs.readdirSync(pastaAmostras).filter((f) => /^\d{16}\.html$/.test(f)) : [];
describe.skipIf(!amostras.length)('todas as amostras reais', () => {
  it.each(amostras)('%s: parseia, sem seção desconhecida, autores e títulos coerentes', (f) => {
    const r = parseHtmlCV(fs.readFileSync(new URL(f, pastaAmostras), 'utf8'));
    expect(r.lattesId).toBe(f.slice(0, 16));
    expect(r.desconhecidos).toEqual([]);
    for (const o of r.obras) {
      expect(o.autores.length, o.dados.CITACAO).toBeGreaterThan(0);
      // Sem ano só quando a citação não tem nenhum (dado faltando no Lattes, não erro do parser).
      if (o.ano === null) expect(o.dados.CITACAO, 'ano não extraído').not.toMatch(/\b(19|20)\d\d\b/);
    }
  });
});

// Amostra real (fora do git, em data/amostras/): só roda se existir.
const amostra = new URL('../../data/amostras/8053099877923725.html', import.meta.url);
describe.skipIf(!fs.existsSync(amostra))('amostra real', () => {
  it('extrai o CV inteiro sem seções desconhecidas', () => {
    const r = parseHtmlCV(fs.readFileSync(amostra, 'utf8'));
    expect(r.lattesId).toBe('8053099877923725');
    expect(r.obras).toHaveLength(35);
    expect(r.obras.filter((o) => o.tipo === 'artigo').every((o) => o.doi && o.veiculo)).toBe(true);
    expect(r.orientacoes).toHaveLength(9);
    expect(r.desconhecidos).toEqual([]);
    expect(r.vinculados).toEqual([{ lattesId: '6002385867822713', nome: 'Wilson José Flores Júnior' }]);
  });
});
