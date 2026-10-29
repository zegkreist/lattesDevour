import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('API (Postgres)', () => {
  let app: import('fastify').FastifyInstance;
  let pool: typeof import('../src/db.js').pool;
  const raw = fs.readFileSync(new URL('./fixtures/cv-1111111111111111.xml', import.meta.url));
  const get = async (u: string) => {
    const r = await app.inject({ method: 'GET', url: u });
    expect(r.statusCode, `${u} -> ${r.body}`).toBe(200);
    return r.json();
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const db = await import('../src/db.js');
    pool = db.pool;
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await db.migrate();
    const { default: Fastify } = await import('fastify');
    const { rotas } = await import('../src/api/routes.js');
    const { parseCV } = await import('../src/parsers/index.js');
    const { ingest } = await import('../src/store/ingest.js');
    const { decodeXml } = await import('../src/util/xmlfile.js');
    app = Fastify();
    await app.register(rotas);
    const r = parseCV(decodeXml(raw));
    await ingest(r.cv, { parser: r.parser, versao: r.versao, xmlSha256: 'x' });
  });
  afterAll(async () => { await app.close(); await pool.end(); });

  it('filtra só por tags (sem texto de busca)', async () => {
    expect((await get('/api/obras?regiao=sudeste&tipo=artigo')).itens).toHaveLength(1);
    expect((await get('/api/obras?regiao=sul')).total).toBe(0);
    expect((await get('/api/pesquisadores?tema=CIENCIAS_BIOLOGICAS')).total).toBe(1);
    expect((await get('/api/obras?kw=lagos&ano_de=2018&ano_ate=2019')).itens).toHaveLength(1);
  });

  it('busca por texto sem acento e ordena por relevância', async () => {
    const r = await get('/api/obras?q=eutrofizacao');
    expect(r.itens[0].titulo).toBe('Eutrofização em lagos urbanos');
    expect((await get('/api/pesquisadores?q=maria%20alvares')).itens[0].nome).toMatch(/Maria/);
  });

  it('grafo, perfil, facetas e painel respondem', async () => {
    expect((await get('/api/graph?modo=colab')).nodes).toHaveLength(1);
    expect((await get('/api/graph?modo=obras&uf=MG')).edges).toBeDefined();
    expect((await get('/api/pesquisadores/1111111111111111')).obras).toHaveLength(5);
    expect((await get('/api/facets')).ufs).toEqual([{ v: 'MG', n: '1' }]);
    expect((await get('/api/stats')).totais.obras).toBe(5);
  });

  it('enfileira só IDs de 16 dígitos', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/fila/enfileirar', payload: { texto: 'http://lattes.cnpq.br/3333333333333333 4444444444444444 123 12345678901234567' } });
    expect(r.json()).toEqual({ encontrados: 2, novos: 2 });
  });
});
