import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Integração: precisa de um Postgres (TEST_DATABASE_URL) e de internet na primeira vez, para a
// extensão postgres do DuckDB. Sem o banco, o arquivo é pulado.
const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const A = '1111111111111111';
const B = '2222222222222222';
const PENDENTE = '3333333333333333';
const SEM_CV = '4444444444444444';

d('importar a cópia de outro Lattes Devour', () => {
  let app: import('fastify').FastifyInstance;
  let pool: typeof import('../src/db.js').pool;
  let reprocessar: typeof import('../src/collector/pipeline.js').reprocessar;
  let ingerir: (xml: string) => Promise<unknown>;
  let zip: Buffer;
  let origem: Record<string, unknown>;
  const raw = fs.readFileSync(new URL('./fixtures/cv-1111111111111111.xml', import.meta.url));
  let xmlA: string;
  let xmlB: string;

  const TABELAS = 'fila, instituicao, pesquisador, obra, obra_fonte, autoria, orientacao, parse_log';
  const zerar = () => pool.query(`TRUNCATE ${TABELAS} RESTART IDENTITY CASCADE`);
  const linhas = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows;
  const importar = (corpo: Buffer | Uint8Array, tipo = 'application/zip') =>
    app.inject({ method: 'POST', url: '/api/importar', headers: { 'content-type': tipo }, payload: Buffer.from(corpo) });
  const retrato = async () => ({
    pesquisadores: await linhas(`SELECT p.id, p.nome, p.uf, p.tags, p.formacao, i.nome AS inst FROM pesquisador p LEFT JOIN instituicao i ON i.id = p.instituicao_id ORDER BY p.id`),
    obras: await linhas(`SELECT chave, titulo, doi, tags, palavras_chave, dados FROM obra ORDER BY chave`),
    fontes: await linhas(`SELECT o.chave, f.pesquisador_id, f.parser FROM obra_fonte f JOIN obra o ON o.id = f.obra_id ORDER BY 1, 2`),
    autoria: await linhas(`SELECT o.chave, a.ordem, a.nome, a.autor_lattes_id FROM autoria a JOIN obra o ON o.id = a.obra_id ORDER BY 1, 2`),
    orientacoes: await linhas(`SELECT orientador_id, orientado_nome, nivel, titulo FROM orientacao ORDER BY 1, 2`),
    logs: await linhas(`SELECT pesquisador_id, parser, obras, desconhecidos FROM parse_log ORDER BY 1`),
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-import-'));
    const db = await import('../src/db.js');
    pool = db.pool;
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await db.migrate();
    const { default: Fastify } = await import('fastify');
    const { rotas } = await import('../src/api/routes.js');
    const { parseCV } = await import('../src/parsers/index.js');
    const { ingest } = await import('../src/store/ingest.js');
    const { decodeXml } = await import('../src/util/xmlfile.js');
    ({ reprocessar } = await import('../src/collector/pipeline.js'));
    app = Fastify();
    await app.register(rotas);
    ingerir = (xml) => { const r = parseCV(xml); return ingest(r.cv, { parser: r.parser, versao: r.versao, xmlSha256: 'x' }); };
    xmlA = decodeXml(raw);
    xmlB = xmlA
      .replace(`NUMERO-IDENTIFICADOR="${A}"`, `NUMERO-IDENTIFICADOR="${B}"`)
      .replace('NOME-COMPLETO="Maria da Conceição Álvares"', 'NOME-COMPLETO="Carlos Souza"')
      .replace('NOME-EM-CITACOES-BIBLIOGRAFICAS="ÁLVARES, M. C.;ALVARES, M."', 'NOME-EM-CITACOES-BIBLIOGRAFICAS="SOUZA, C."')
      .replace('UF="MG" CIDADE="Belo Horizonte"', 'UF="BA" CIDADE="Salvador"')
      .replace('NOME-INSTITUICAO-EMPRESA="Universidade Federal de Minas Gerais"', 'NOME-INSTITUICAO-EMPRESA="Universidade Federal da Bahia"');

    // A base de origem: dois CVs com obras em comum e uma fila com o que falta coletar.
    await ingerir(xmlA);
    await ingerir(xmlB);
    await pool.query(`UPDATE fila SET html_path = '/outra/maquina/' || lattes_id || '.html'`);
    await pool.query(`INSERT INTO fila (lattes_id, status, html_path) VALUES ($1, 'html', '/outra/maquina/x.html'), ($2, 'sem_cv', NULL)`, [PENDENTE, SEM_CV]);
    await pool.query(`UPDATE fila SET ultimo_erro = 'ID não existe' WHERE lattes_id = $1`, [SEM_CV]);
    origem = await retrato();
    expect((await app.inject({ method: 'POST', url: '/api/exportar' })).statusCode).toBe(200);
    const r = await app.inject({ method: 'GET', url: '/api/exportar/zip' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    zip = r.rawPayload;
  }, 120_000);
  afterAll(async () => { await app.close(); await pool.end(); });

  it('numa base vazia, reproduz a base de origem', async () => {
    await zerar();
    const r = await importar(zip);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ cvsNovos: 2, cvsAtualizados: 0, cvsMantidos: 0, naFila: 1 });
    expect(r.json().obrasNovas).toBeGreaterThan(0);
    expect(await retrato()).toEqual(origem);
  }, 60_000);

  it('a busca funciona com o que foi importado', async () => {
    const get = async (u: string) => (await app.inject({ method: 'GET', url: u })).json();
    expect((await get('/api/obras?q=eutrofizacao')).itens[0].titulo).toBe('Eutrofização em lagos urbanos');
    expect((await get('/api/pesquisadores?q=carlos%20souza')).itens[0].id).toBe(B);
    expect(await linhas(`SELECT id::text FROM obra WHERE tsv IS NULL UNION ALL SELECT id FROM pesquisador WHERE tsv IS NULL`)).toEqual([]);
  });

  it('traz a fila sem caminhos da outra máquina, e o que estava em andamento volta a pendente', async () => {
    const fila = await linhas(`SELECT lattes_id, status, origem, xml_path, html_path, ultimo_erro FROM fila ORDER BY 1`);
    expect(fila).toEqual([
      { lattes_id: A, status: 'parseado', origem: 'importado', xml_path: null, html_path: null, ultimo_erro: null },
      { lattes_id: B, status: 'parseado', origem: 'importado', xml_path: null, html_path: null, ultimo_erro: null },
      { lattes_id: PENDENTE, status: 'pendente', origem: 'importado', xml_path: null, html_path: null, ultimo_erro: null },
      { lattes_id: SEM_CV, status: 'sem_cv', origem: 'importado', xml_path: null, html_path: null, ultimo_erro: 'ID não existe' },
    ]);
  });

  it('importar de novo não muda nada', async () => {
    const r = await importar(zip);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ cvsNovos: 0, cvsAtualizados: 0, cvsMantidos: 2, obrasNovas: 0, naFila: 0 });
    expect(await retrato()).toEqual(origem);
  }, 60_000);

  it('CV importado não tem arquivo: nem o reprocesso nem uma UF nova o mandam para o parse', async () => {
    expect(await reprocessar()).toBe(0);
    // Uma instituição sem UF que ganha UF devolve ao parse quem estava ligado a ela; sem arquivo, não pode.
    await pool.query(`UPDATE instituicao SET uf = NULL, regiao = NULL WHERE nome = 'Universidade Federal da Bahia'`);
    await pool.query(`UPDATE pesquisador SET uf = NULL, regiao = NULL WHERE id = $1`, [B]);
    await ingerir(xmlB.replace(`NUMERO-IDENTIFICADOR="${B}"`, 'NUMERO-IDENTIFICADOR="5555555555555555"').replace('NOME-COMPLETO="Carlos Souza"', 'NOME-COMPLETO="Dora Lima"'));
    expect((await linhas(`SELECT status FROM fila WHERE lattes_id = $1`, [B]))[0].status).toBe('parseado');
  });

  it('CV igual nas duas bases fica o daqui; o novo entra e as obras em comum se unem', async () => {
    await zerar();
    await ingerir(xmlA);
    await pool.query(`UPDATE pesquisador SET resumo = 'versão local' WHERE id = $1`, [A]);
    await pool.query(`INSERT INTO fila (lattes_id, status, tentativas, ultimo_erro) VALUES ($1, 'erro', 3, 'falhou aqui') ON CONFLICT DO NOTHING`, [B]);
    const r = await importar(zip);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ cvsNovos: 1, cvsAtualizados: 0, cvsMantidos: 1 });
    // Local preservado; o CV novo entrou e tirou o erro local da fila.
    expect((await linhas(`SELECT resumo FROM pesquisador WHERE id = $1`, [A]))[0].resumo).toBe('versão local');
    expect((await linhas(`SELECT status, ultimo_erro FROM fila WHERE lattes_id = $1`, [B]))[0]).toEqual({ status: 'parseado', ultimo_erro: null });
    const art = await linhas(`SELECT (SELECT count(*)::int FROM obra_fonte WHERE obra_id = o.id) AS fontes, o.tags FROM obra o WHERE doi = '10.1000/abc.123'`);
    expect(art).toHaveLength(1);
    expect(art[0].fontes).toBe(2);
    expect(art[0].tags).toEqual(expect.arrayContaining(['uf:MG', 'uf:BA']));
    // Mesmo conteúdo de obras e autoria que a base de origem, onde os dois CVs nasceram juntos.
    const agora = await retrato();
    expect(agora.obras).toEqual(origem.obras);
    expect(agora.autoria).toEqual(origem.autoria);
  }, 60_000);

  describe('CV nas duas bases: fica o mais recente e, no empate de data, o maior', () => {
    // A é o CV da cópia. Prepara a versão local e devolve o que o import fez com ela.
    const preparar = async (ajuste: 'mais antigo' | 'mais novo' | 'sem data' | 'mesma data') => {
      await zerar();
      await ingerir(xmlA);
      const expr = { 'mais antigo': `data_atualizacao_cv - 1`, 'mais novo': `data_atualizacao_cv + 1`, 'sem data': 'NULL', 'mesma data': 'data_atualizacao_cv' }[ajuste];
      await pool.query(`UPDATE pesquisador SET data_atualizacao_cv = ${expr}, resumo = 'versão local' WHERE id = $1`, [A]);
    };
    /** Obra e orientação que só a versão local declara: deixam o CV local maior que o da cópia. */
    const engordar = async () => {
      const o = await linhas(`INSERT INTO obra (chave, tipo, titulo, titulo_norm) VALUES ('so-local', 'artigo', 'Só local', 'so local') RETURNING id`);
      await pool.query(`INSERT INTO obra_fonte (obra_id, pesquisador_id, parser) VALUES ($1, $2, 'lattes-html-v1')`, [o[0].id, A]);
    };
    /** Tira uma obra da versão local, deixando-a menor que a da cópia. */
    const emagrecer = async () => {
      await pool.query(`DELETE FROM obra_fonte WHERE pesquisador_id = $1 AND obra_id = (SELECT min(obra_id) FROM obra_fonte WHERE pesquisador_id = $1)`, [A]);
    };
    const resumo = async () => (await linhas(`SELECT resumo FROM pesquisador WHERE id = $1`, [A]))[0].resumo;
    const obraSoLocal = async () => (await linhas(`SELECT 1 FROM obra WHERE chave = 'so-local'`)).length;

    it('a fixture tem data de atualização', async () => {
      expect((origem.pesquisadores as { id: string }[]).length).toBe(2);
      expect((await linhas(`SELECT data_atualizacao_cv FROM pesquisador WHERE id = $1`, [A]))[0].data_atualizacao_cv).not.toBeNull();
    });

    it('a cópia mais recente vence mesmo sendo menor, e a versão local sai inteira', async () => {
      await preparar('mais antigo');
      await engordar();
      await pool.query(`INSERT INTO orientacao (orientador_id, orientado_nome, nivel, titulo) VALUES ($1, 'Só Local', 'mestrado', 'x')`, [A]);
      await pool.query(`UPDATE fila SET html_path = '/aqui/antigo.html' WHERE lattes_id = $1`, [A]);
      const r = (await importar(zip)).json();
      expect(r).toMatchObject({ cvsNovos: 1, cvsAtualizados: 1, cvsMantidos: 0 });
      expect(await resumo()).not.toBe('versão local');
      expect(await obraSoLocal()).toBe(0);
      expect(await linhas(`SELECT 1 FROM orientacao WHERE orientado_nome = 'Só Local'`)).toEqual([]);
      expect((await linhas(`SELECT status, origem, html_path FROM fila WHERE lattes_id = $1`, [A]))[0]).toEqual({ status: 'parseado', origem: 'importado', html_path: null });
      expect(await retrato()).toEqual(origem);
    }, 60_000);

    it('a versão local mais recente vence mesmo sendo menor', async () => {
      await preparar('mais novo');
      await emagrecer();
      expect((await importar(zip)).json()).toMatchObject({ cvsAtualizados: 0, cvsMantidos: 1 });
      expect(await resumo()).toBe('versão local');
    }, 60_000);

    it('sem data perde para quem tem data', async () => {
      await preparar('sem data');
      await engordar();
      expect((await importar(zip)).json()).toMatchObject({ cvsAtualizados: 1 });
      expect(await resumo()).not.toBe('versão local');
    }, 60_000);

    it('mesma data: vence a maior; a local só perde se for menor', async () => {
      await preparar('mesma data');
      await engordar();
      expect((await importar(zip)).json()).toMatchObject({ cvsAtualizados: 0, cvsMantidos: 1 });
      expect(await resumo()).toBe('versão local');
      expect(await obraSoLocal()).toBe(1);

      await preparar('mesma data');
      await emagrecer();
      expect((await importar(zip)).json()).toMatchObject({ cvsAtualizados: 1, cvsMantidos: 0 });
      expect(await resumo()).not.toBe('versão local');
    }, 60_000);

    it('CV sendo baixado ou parseado aqui não é trocado, mesmo mais antigo', async () => {
      await preparar('mais antigo');
      await pool.query(`UPDATE fila SET status = 'html' WHERE lattes_id = $1`, [A]);
      expect((await importar(zip)).json()).toMatchObject({ cvsAtualizados: 0, cvsMantidos: 1 });
      expect(await resumo()).toBe('versão local');
      expect((await linhas(`SELECT status FROM fila WHERE lattes_id = $1`, [A]))[0].status).toBe('html');
    }, 60_000);

    it('a versão que perdeu não volta pelo arquivo em disco, mas uma coleta nova vale', async () => {
      await preparar('mais antigo');
      expect((await importar(zip)).json()).toMatchObject({ cvsAtualizados: 1 });
      const dir = path.join(process.env.DATA_DIR!, 'html');
      fs.mkdirSync(dir, { recursive: true });
      const arquivo = path.join(dir, `${A}.html`);
      fs.writeFileSync(arquivo, '<html>versão antiga que ficou em disco</html>');
      expect(await reprocessar()).toBe(0);
      expect((await linhas(`SELECT status, html_path FROM fila WHERE lattes_id = $1`, [A]))[0]).toEqual({ status: 'parseado', html_path: null });
      // Coletado de novo aqui, o caminho volta a existir e o reprocesso alcança o CV.
      await pool.query(`UPDATE fila SET html_path = $2 WHERE lattes_id = $1`, [A, arquivo]);
      expect(await reprocessar()).toBe(1);
      fs.rmSync(arquivo);
      await pool.query(`UPDATE fila SET status = 'parseado' WHERE lattes_id = $1`, [A]);
    }, 60_000);
  });

  it('recusa o que não é uma exportação, sem mexer na base', async () => {
    const antes = await retrato();
    const invalido = await importar(Buffer.from('isto não é um zip'));
    expect(invalido.statusCode).toBe(400);
    expect(invalido.json().erro).toMatch(/\.zip válido/);
    const incompleto = await importar(zipSync({ 'obra.parquet': new Uint8Array([1, 2, 3]) }));
    expect(incompleto.statusCode).toBe(400);
    expect(incompleto.json().erro).toMatch(/não tem fila\.parquet/);
    const repetido = await importar(zipSync({ 'a/obra.parquet': new Uint8Array([1]), 'b/obra.parquet': new Uint8Array([2]) }));
    expect(repetido.statusCode).toBe(400);
    expect(repetido.json().erro).toMatch(/mais de um obra\.parquet/);
    expect((await app.inject({ method: 'POST', url: '/api/importar', headers: { 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(400);
    expect(await retrato()).toEqual(antes);
    expect(await linhas(`SELECT 1 FROM information_schema.schemata WHERE schema_name = 'importacao'`)).toEqual([]);
  }, 60_000);

  it('o que sai do zip é só o nome-base conhecido: caminhos do zip não escapam da pasta', async () => {
    const r = await importar(zipSync({ '../../fora.parquet': new Uint8Array([1]), '../fila.txt': new Uint8Array([1]) }));
    expect(r.statusCode).toBe(400);
    expect(fs.existsSync(path.join(os.tmpdir(), 'fora.parquet'))).toBe(false);
  });
});
