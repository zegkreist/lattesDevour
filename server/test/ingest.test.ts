import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Integração: precisa de um Postgres (TEST_DATABASE_URL). Sem ele, o arquivo é pulado.
const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('ingest + busca (Postgres)', () => {
  let pool: typeof import('../src/db.js').pool;
  let ingest: typeof import('../src/store/ingest.js').ingest;
  let parseCV: typeof import('../src/parsers/index.js').parseCV;
  let decodeXml: typeof import('../src/util/xmlfile.js').decodeXml;
  const raw = fs.readFileSync(new URL('./fixtures/cv-1111111111111111.xml', import.meta.url));

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    ({ pool } = await import('../src/db.js'));
    const { migrate } = await import('../src/db.js');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate();
    ({ ingest } = await import('../src/store/ingest.js'));
    ({ parseCV } = await import('../src/parsers/index.js'));
    ({ decodeXml } = await import('../src/util/xmlfile.js'));
  });
  afterAll(async () => { await pool.end(); });

  const run = (xml: string) => { const r = parseCV(xml); return ingest(r.cv, { parser: r.parser, versao: r.versao, xmlSha256: 'x' }); };

  it('grava pesquisador, obras, autoria e orientações', async () => {
    const r = await run(decodeXml(raw));
    expect(r).toEqual({ obras: 5, orientacoes: 2 });
    const p = (await pool.query(`SELECT uf, regiao, tags FROM pesquisador WHERE id='1111111111111111'`)).rows[0];
    expect(p.uf).toBe('MG');
    expect(p.regiao).toBe('sudeste');
    expect(p.tags).toEqual(expect.arrayContaining(['uf:MG', 'regiao:sudeste', 'inst:universidade-federal-de-minas-gerais', 'tema:ciencias-biologicas']));
    expect((await pool.query(`SELECT status FROM fila WHERE lattes_id='1111111111111111'`)).rows[0].status).toBe('parseado');
  });

  it('resolve o dono do CV na autoria pelo nome quando NRO-ID vem vazio', async () => {
    const r = await pool.query(`SELECT a.autor_lattes_id FROM autoria a JOIN obra o ON o.id=a.obra_id WHERE o.tipo='evento' AND a.ordem=1`);
    expect(r.rows[0].autor_lattes_id).toBe('1111111111111111');
  });

  it('é idempotente: reprocessar não duplica', async () => {
    await run(decodeXml(raw));
    expect(Number((await pool.query('SELECT count(*) FROM obra')).rows[0].count)).toBe(5);
    expect(Number((await pool.query('SELECT count(*) FROM orientacao')).rows[0].count)).toBe(2);
    expect(Number((await pool.query('SELECT count(*) FROM obra_fonte')).rows[0].count)).toBe(5);
  });

  it('deduplica a mesma obra entre CVs (DOI) e liga os dois pesquisadores', async () => {
    const outro = decodeXml(raw)
      .replace('NUMERO-IDENTIFICADOR="1111111111111111"', 'NUMERO-IDENTIFICADOR="2222222222222222"')
      .replace('NOME-COMPLETO="Maria da Conceição Álvares"', 'NOME-COMPLETO="Carlos Souza"')
      .replace('NOME-EM-CITACOES-BIBLIOGRAFICAS="ÁLVARES, M. C.;ALVARES, M."', 'NOME-EM-CITACOES-BIBLIOGRAFICAS="SOUZA, C."')
      .replace('UF="MG" CIDADE="Belo Horizonte"', 'UF="BA" CIDADE="Salvador"')
      .replace('NOME-INSTITUICAO-EMPRESA="Universidade Federal de Minas Gerais"', 'NOME-INSTITUICAO-EMPRESA="Universidade Federal da Bahia"');
    await run(outro);
    const art = await pool.query(`SELECT o.id, (SELECT count(*) FROM obra_fonte WHERE obra_id=o.id) fontes, o.tags FROM obra o WHERE doi='10.1000/abc.123'`);
    expect(art.rows).toHaveLength(1);
    expect(Number(art.rows[0].fontes)).toBe(2);
    expect(art.rows[0].tags).toEqual(expect.arrayContaining(['uf:MG', 'uf:BA', 'regiao:nordeste']));
  });

  it('busca por título sem acento, por tag e por trigrama', async () => {
    const fts = await pool.query(`SELECT titulo FROM obra WHERE tsv @@ plainto_tsquery('portuguese','eutrofizacao lagos')`);
    expect(fts.rows.map((r) => r.titulo)).toContain('Eutrofização em lagos urbanos');
    const tag = await pool.query(`SELECT titulo FROM obra WHERE tags @> ARRAY['regiao:nordeste','tipo:artigo']`);
    expect(tag.rows).toHaveLength(1);
    const tri = await pool.query(`SELECT nome FROM pesquisador WHERE nome_norm % 'maria conceicao alvares'`);
    expect(tri.rows[0].nome).toContain('Maria');
  });

  it('o grafo de coautoria liga os dois pesquisadores coletados', async () => {
    const r = await pool.query(
      `SELECT a.autor_lattes_id a, b.autor_lattes_id b, count(*) w FROM autoria a JOIN autoria b
       ON a.obra_id=b.obra_id AND a.autor_lattes_id < b.autor_lattes_id
       WHERE a.autor_lattes_id IN ('1111111111111111','2222222222222222') AND b.autor_lattes_id IN ('1111111111111111','2222222222222222') GROUP BY 1,2`);
    expect(r.rows).toHaveLength(1);
    expect(Number(r.rows[0].w)).toBeGreaterThanOrEqual(2); // artigo + evento
  });

  it('mesma obra por HTML e XML: cada CV guarda a sua versão e obra.dados funde (XML vence)', async () => {
    const { parseHtmlCV, HTML_PARSER } = await import('../src/parsers/index.js');
    const html = fs.readFileSync(new URL('./fixtures/cv-html-sintetico.html', import.meta.url), 'utf8')
      .replaceAll('1234567890123456', '3333333333333333')
      .replaceAll('10.1234/ABC.2024.1', '10.1000/ABC.123');
    await ingest(parseHtmlCV(html), { ...HTML_PARSER, xmlSha256: 'h' });
    const o = (await pool.query(`SELECT id, veiculo, dados FROM obra WHERE doi='10.1000/abc.123'`)).rows[0];
    // XML disse volume 66 e periódico Freshwater Biology; o HTML diz 7 e outro nome: vale o XML.
    expect(o.veiculo).toBe('Freshwater Biology');
    expect(o.dados.VOLUME).toBe('66');
    // O que só o HTML trouxe entra na fusão.
    expect(o.dados['PAGINA-INICIAL']).toBe('1');
    expect(o.dados.CITACAO).toMatch(/^SOUZA, A\. F\./);
    const fontes = (await pool.query(`SELECT pesquisador_id, parser, dados->>'VOLUME' v FROM obra_fonte WHERE obra_id=$1 ORDER BY 1`, [o.id])).rows;
    expect(fontes).toEqual([
      { pesquisador_id: '1111111111111111', parser: 'lattes-xml-v1', v: '66' },
      { pesquisador_id: '2222222222222222', parser: 'lattes-xml-v1', v: '66' },
      { pesquisador_id: '3333333333333333', parser: 'lattes-html-v1', v: '7' },
    ]);
  });

  it('autoria da obra vem da melhor fonte (XML) e o coautor com link no HTML ganha o ID', async () => {
    const art = await pool.query(
      `SELECT a.nome, a.autor_lattes_id FROM autoria a JOIN obra o ON o.id = a.obra_id WHERE o.doi = '10.1000/abc.123' ORDER BY a.ordem`,
    );
    expect(art.rows.map((r) => r.autor_lattes_id)).toEqual(['1111111111111111', '2222222222222222', '3333333333333333']);
    const cap = await pool.query(
      `SELECT a.nome, a.autor_lattes_id FROM autoria a JOIN obra o ON o.id = a.obra_id WHERE o.tipo = 'capitulo' AND o.titulo = 'O romance e a cidade' ORDER BY a.ordem`,
    );
    // LIMA tem link para o Lattes no HTML; SOUZA é a dona do CV, resolvida pelo nome de citação.
    expect(cap.rows).toEqual([
      { nome: 'LIMA, B. I.', autor_lattes_id: '6543210987654321' },
      { nome: 'SOUZA, A. F.', autor_lattes_id: '3333333333333333' },
    ]);
  });

  it('reprocessar um CV troca só a contribuição dele: nada velho fica', async () => {
    const { parseHtmlCV, HTML_PARSER } = await import('../src/parsers/index.js');
    // Mesma pessoa, agora em Cuiabá/MT, e o capítulo corrigido sem o coautor LIMA.
    const html = fs.readFileSync(new URL('./fixtures/cv-html-sintetico.html', import.meta.url), 'utf8')
      .replaceAll('1234567890123456', '3333333333333333')
      .replaceAll('10.1234/ABC.2024.1', '10.1000/ABC.123')
      .replace('74000000 - Goiânia, GO - Brasil', '78000000 - Cuiabá, MT - Brasil')
      .replace(/<a class="tooltip"[^>]*>LIMA, B\. I\.<\/a> ; /, '');
    await ingest(parseHtmlCV(html), { ...HTML_PARSER, xmlSha256: 'h2' });

    const tags = (await pool.query(`SELECT tags FROM obra WHERE doi='10.1000/abc.123'`)).rows[0].tags as string[];
    // Obra compartilhada: as UFs dos três CVs, com a nova no lugar da antiga.
    expect(tags).toEqual(expect.arrayContaining(['uf:MG', 'uf:BA', 'uf:MT']));
    expect(tags).not.toContain('uf:GO');
    const cap = await pool.query(
      `SELECT a.nome FROM autoria a JOIN obra o ON o.id = a.obra_id WHERE o.tipo = 'capitulo' AND o.titulo = 'O romance e a cidade' ORDER BY a.ordem`,
    );
    expect(cap.rows.map((r) => r.nome)).toEqual(['SOUZA, A. F.']);
    // A instituição em GO só era usada por este CV e ficou órfã.
    expect((await pool.query(`SELECT count(*)::int n FROM instituicao WHERE uf = 'GO'`)).rows[0].n).toBe(0);
    // Os outros dois CVs continuam declarando o artigo, com os mesmos autores.
    const fontes = (await pool.query(`SELECT count(*)::int n FROM obra_fonte f JOIN obra o ON o.id = f.obra_id WHERE o.doi='10.1000/abc.123'`)).rows[0].n;
    expect(fontes).toBe(3);
  });

  it('sem endereço profissional, a UF vem da instituição (a já conhecida no banco)', async () => {
    const { parseHtmlCV, HTML_PARSER } = await import('../src/parsers/index.js');
    const semEndereco = fs.readFileSync(new URL('./fixtures/cv-html-sintetico.html', import.meta.url), 'utf8')
      .replace(/<div class="title-wrapper"><a name="Endereco">[\s\S]*?(?=<div class="title-wrapper"><a name="FormacaoAcademicaTitulacao">)/, '');
    // "Universidade Federal Fictícia" já tem UF no banco (MT, do CV 3333 com endereço).
    await ingest(parseHtmlCV(semEndereco.replaceAll('1234567890123456', '4444444444444444')), { ...HTML_PARSER, xmlSha256: 'h' });
    const p = (await pool.query(`SELECT uf, regiao, tags FROM pesquisador WHERE id='4444444444444444'`)).rows[0];
    expect(p).toMatchObject({ uf: 'MT', regiao: 'centro-oeste' });
    expect(p.tags).toEqual(expect.arrayContaining(['uf:MT', 'regiao:centro-oeste']));
    const avisos = (await pool.query(`SELECT avisos FROM parse_log WHERE pesquisador_id='4444444444444444'`)).rows[0].avisos;
    expect(avisos).toContain('UF MT inferida pela instituição "Universidade Federal Fictícia"');

    // Instituição sem UF conhecida e sem pista no nome: fica sem UF... até um CV com endereço dela chegar.
    const novo = semEndereco.replaceAll('Universidade Federal Fictícia', 'Instituto Novo').replaceAll('Universidade de Lisboa', 'Instituto Novo');
    await ingest(parseHtmlCV(novo.replaceAll('1234567890123456', '5555555555555555')), { ...HTML_PARSER, xmlSha256: 'h' });
    expect((await pool.query(`SELECT uf FROM pesquisador WHERE id='5555555555555555'`)).rows[0].uf).toBeNull();
    const comEndereco = fs.readFileSync(new URL('./fixtures/cv-html-sintetico.html', import.meta.url), 'utf8')
      .replaceAll('Universidade Federal Fictícia', 'Instituto Novo').replaceAll('1234567890123456', '6666666666666666');
    await ingest(parseHtmlCV(comEndereco), { ...HTML_PARSER, xmlSha256: 'h' });
    // O 5555 volta para a fila de parse para ganhar a UF.
    expect((await pool.query(`SELECT status FROM fila WHERE lattes_id='5555555555555555'`)).rows[0].status).toBe('html');
  });
});
