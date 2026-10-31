import os from 'node:os';
import path from 'node:path';
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
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-test-'));
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
    // Rede a partir do filtro: a semente fica no nível 0 e os coautores sem Lattes coletado entram expandidos.
    const rede = await get('/api/graph?modo=colab&regiao=sudeste&niveis=2');
    expect(rede.nodes.find((n: any) => n.id === '1111111111111111').nivel).toBe(0);
    expect((await get('/api/graph?modo=colab&regiao=sul&niveis=2')).nodes).toHaveLength(0);
    expect((await get('/api/pesquisadores/1111111111111111')).obras).toHaveLength(5);
    expect((await get('/api/facets')).ufs).toEqual([{ v: 'MG', n: '1' }]);
    expect((await get('/api/stats')).totais.obras).toBe(5);
  });

  it('próximos: cita quem não foi coletado e a limpeza da fila só toca pendente/erro', async () => {
    const r = await get('/api/proximos?regiao=sudeste');
    expect(r.itens.every((i: any) => i.id !== '1111111111111111' && i.vinculos >= 1)).toBe(true);
    expect((await get('/api/proximos?regiao=sul')).total).toBe(0);
    await app.inject({ method: 'POST', url: '/api/fila/enfileirar', payload: { texto: '5555555555555555' } });
    const del = await app.inject({ method: 'DELETE', url: '/api/fila?status=pendente' });
    expect(del.json().removidos).toBeGreaterThanOrEqual(1);
    expect((await app.inject({ method: 'DELETE', url: '/api/fila?status=parseado' })).statusCode).toBe(400);
    expect((await get('/api/pesquisadores/1111111111111111')).nome).toBeTruthy();
  });

  it('enfileira só IDs de 16 dígitos', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/fila/enfileirar', payload: { texto: 'http://lattes.cnpq.br/3333333333333333 4444444444444444 123 12345678901234567' } });
    expect(r.json()).toEqual({ encontrados: 2, novos: 2 });
  });

  it('apagar o banco: exige a senha, grava Parquet e esvazia (mantém settings)', async () => {
    await pool.query(`INSERT INTO settings (chave, valor) VALUES ('teste', '1') ON CONFLICT DO NOTHING`);
    const senha = decodeURIComponent(new URL(url!).password);
    expect((await app.inject({ method: 'POST', url: '/api/db/limpar', payload: { senha: 'errada' } })).statusCode).toBe(403);
    expect((await pool.query('SELECT count(*) FROM pesquisador')).rows[0].count).toBe('1');
    const r = await app.inject({ method: 'POST', url: '/api/db/limpar', payload: { senha } });
    expect(r.statusCode, r.body).toBe(200);
    expect(fs.existsSync(path.join(r.json().dir, 'pesquisador.parquet'))).toBe(true);
    expect((await pool.query('SELECT count(*) FROM pesquisador')).rows[0].count).toBe('0');
    expect((await pool.query('SELECT count(*) FROM obra')).rows[0].count).toBe('0');
    expect((await pool.query(`SELECT count(*) FROM settings WHERE chave='teste'`)).rows[0].count).toBe('1');
  });
});
