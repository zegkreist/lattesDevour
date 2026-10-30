import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { zipSync } from 'fflate';
import { fazerBackup } from '../backup.js';
import { config, paths } from '../config.js';
import * as coletor from '../collector/collector.js';
import { htmlPathFor, importarPasta, reprocessar, xmlPathFor } from '../collector/pipeline.js';
import { chave2Captcha, saldo } from '../collector/twocaptcha.js';
import { pool, setSetting } from '../db.js';
import { adicionarAlvos, buscarPorNome, descobrindo, descobrirInstituicao } from '../discovery/orcid.js';
import { enfileirar, extrairIds } from '../discovery/ids.js';
import { exportarParquet } from '../exportar.js';
import { currentParserVersion, listParsers } from '../parsers/index.js';
import { norm, slug } from '../util/text.js';

type Q = Record<string, string | undefined>;
const lista = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const intOr = (v: string | undefined, d: number, max = 200) => Math.min(Math.max(parseInt(v ?? '', 10) || d, 1), max);

/**
 * Filtros compartilhados por busca de pesquisadores, de obras e pelo grafo. Cada um vira
 * condição sobre `tags` (GIN) — é o que mantém a busca rápida com muitas combinações.
 */
function tagsDe(q: Q): string[] {
  const t: string[] = [];
  for (const v of lista(q.uf)) t.push(`uf:${v.toUpperCase()}`);
  for (const v of lista(q.regiao)) t.push(`regiao:${slug(v)}`);
  for (const v of lista(q.inst)) t.push(`inst:${slug(v)}`);
  for (const v of lista(q.tema)) t.push(`tema:${slug(v)}`);
  for (const v of lista(q.area)) t.push(`area:${slug(v)}`);
  for (const v of lista(q.tipo)) t.push(`tipo:${slug(v).replace(/-/g, '_')}`);
  for (const v of lista(q.kw)) t.push(`kw:${slug(v)}`);
  for (const v of lista(q.tag)) t.push(v);
  return t;
}

export async function rotas(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true }));

  // ───────────── Painel ─────────────
  app.get('/api/stats', async () => {
    const one = async <T>(sql: string) => (await pool.query(sql)).rows as T[];
    const [fila, tot, porTipo, porRegiao, porUf, desconhecidos, erros, versoes, backups] = await Promise.all([
      one<{ status: string; n: string }>(`SELECT status, count(*) n FROM fila GROUP BY 1`),
      one<any>(`SELECT (SELECT count(*) FROM pesquisador) pesquisadores, (SELECT count(*) FROM obra) obras,
                       (SELECT count(*) FROM autoria) autorias, (SELECT count(*) FROM orientacao) orientacoes,
                       (SELECT count(*) FROM instituicao) instituicoes`),
      one<{ tipo: string; n: string }>(`SELECT tipo, count(*) n FROM obra GROUP BY 1 ORDER BY 2 DESC`),
      one<{ regiao: string; n: string }>(`SELECT COALESCE(regiao,'(sem região)') regiao, count(*) n FROM pesquisador GROUP BY 1 ORDER BY 2 DESC`),
      one<{ uf: string; n: string }>(`SELECT uf, count(*) n FROM pesquisador WHERE uf IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`),
      one<{ path: string; n: string }>(
        `SELECT p AS path, count(*) n FROM parse_log, jsonb_array_elements_text(desconhecidos) p GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
      ),
      one<any>(`SELECT lattes_id, status, ultimo_erro, atualizado_em FROM fila WHERE ultimo_erro IS NOT NULL ORDER BY atualizado_em DESC LIMIT 15`),
      one<{ parser_versao: number; n: string }>(`SELECT parser_versao, count(*) n FROM pesquisador GROUP BY 1`),
      one<any>(`SELECT em, arquivo, bytes, destino, ok, erro FROM backup_log ORDER BY em DESC LIMIT 6`),
    ]);
    return {
      fila: Object.fromEntries(fila.map((r) => [r.status, Number(r.n)])),
      totais: Object.fromEntries(Object.entries(tot[0]).map(([k, v]) => [k, Number(v)])),
      obrasPorTipo: porTipo.map((r) => ({ tipo: r.tipo, n: Number(r.n) })),
      pesquisadoresPorRegiao: porRegiao.map((r) => ({ regiao: r.regiao, n: Number(r.n) })),
      pesquisadoresPorUf: porUf.map((r) => ({ uf: r.uf, n: Number(r.n) })),
      parsers: { registrados: listParsers(), atual: currentParserVersion(), pesquisadoresPorVersao: versoes.map((r) => ({ versao: r.parser_versao, n: Number(r.n) })) },
      desconhecidos: desconhecidos.map((r) => ({ path: r.path, n: Number(r.n) })),
      erros,
      backups,
      backupS3: config.backup.s3Bucket ? `s3://${config.backup.s3Bucket}/${config.backup.s3Prefix}` : null,
    };
  });

  // ───────────── Instituições-alvo ─────────────
  app.get('/api/instituicoes-alvo', async () => {
    const r = await pool.query(`
      SELECT a.*, 
        count(f.*) FILTER (WHERE true) AS ids,
        count(f.*) FILTER (WHERE f.status='pendente') AS pendentes,
        count(f.*) FILTER (WHERE f.status IN ('baixando','aguardando_captcha')) AS em_andamento,
        count(f.*) FILTER (WHERE f.status IN ('baixado','html','parseado')) AS baixados,
        count(f.*) FILTER (WHERE f.status='parseado') AS parseados,
        count(f.*) FILTER (WHERE f.status IN ('erro','sem_cv')) AS falhas
      FROM instituicao_alvo a LEFT JOIN fila f ON f.instituicao_alvo_id = a.id
      GROUP BY a.id ORDER BY a.nome`);
    const ativos = new Set(descobrindo());
    return r.rows.map((x) => ({
      ...x,
      ids: Number(x.ids), pendentes: Number(x.pendentes), em_andamento: Number(x.em_andamento),
      baixados: Number(x.baixados), parseados: Number(x.parseados), falhas: Number(x.falhas),
      descobrindo_agora: ativos.has(x.id),
    }));
  });
  app.post<{ Body: { texto: string } }>('/api/instituicoes-alvo', async (req) => ({ adicionadas: await adicionarAlvos(req.body.texto ?? '') }));
  app.delete<{ Params: { id: string } }>('/api/instituicoes-alvo/:id', async (req) => {
    await pool.query('DELETE FROM instituicao_alvo WHERE id=$1', [req.params.id]);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/instituicoes-alvo/:id/descobrir', async (req) => {
    void descobrirInstituicao(Number(req.params.id));
    return { ok: true };
  });
  app.post('/api/instituicoes-alvo/descobrir-todas', async () => {
    const { rows } = await pool.query(`SELECT id FROM instituicao_alvo WHERE status IN ('pendente','erro','descobrindo') ORDER BY id`);
    void (async () => { for (const r of rows) await descobrirInstituicao(r.id); })();
    return { iniciadas: rows.length };
  });

  // ───────────── Descoberta por nome / fila ─────────────
  app.post<{ Body: { nome: string; instituicao?: string } }>('/api/descoberta/nome', async (req, reply) => {
    if (!req.body.nome?.trim()) return reply.code(400).send({ erro: 'nome obrigatório' });
    return buscarPorNome(req.body.nome, req.body.instituicao);
  });

  // Aceita IDs soltos, lista do CNPq, URLs lattes.cnpq.br/<id>, CSV: qualquer texto com IDs de 16 dígitos.
  app.post<{ Body: { texto: string; alvoId?: number; origem?: string } }>('/api/fila/enfileirar', async (req) => {
    const ids = extrairIds(req.body.texto ?? '');
    return { encontrados: ids.length, novos: await enfileirar(ids, req.body.origem ?? 'lista', req.body.alvoId) };
  });
  app.get<{ Querystring: Q }>('/api/fila', async (req) => {
    const { status } = req.query;
    const lim = intOr(req.query.limit, 50);
    const off = (intOr(req.query.page, 1, 1e6) - 1) * lim;
    const r = await pool.query(
      `SELECT f.lattes_id, f.status, f.origem, f.nome_hint, f.tentativas, f.ultimo_erro, f.atualizado_em, a.nome AS alvo
       FROM fila f LEFT JOIN instituicao_alvo a ON a.id = f.instituicao_alvo_id
       WHERE ($1::text IS NULL OR f.status = $1) ORDER BY f.atualizado_em DESC LIMIT $2 OFFSET $3`,
      [status || null, lim, off],
    );
    return r.rows;
  });
  app.post('/api/fila/retry-erros', async () => {
    const r = await pool.query(`UPDATE fila SET status='pendente', tentativas=0, atualizado_em=now() WHERE status IN ('erro','sem_cv') AND xml_path IS NULL`);
    return { reenfileirados: r.rowCount };
  });

  // ───────────── Coletor / import / reprocesso ─────────────
  app.get('/api/coletor', async () => {
    const { chave, origem } = await chave2Captcha();
    return {
      ...coletor.state,
      captchaAuto: !!chave,
      config: {
        porHora: await coletor.cvsPorHora(),
        porHoraMin: coletor.POR_HORA.min,
        porHoraMax: coletor.POR_HORA.max,
        // A chave nunca volta inteira para o front: só a origem e os 4 últimos caracteres.
        chave2Captcha: origem ? { origem, final: chave.slice(-4) } : null,
      },
    };
  });
  app.post('/api/coletor/iniciar', async () => { coletor.iniciar(); return coletor.state; });
  app.post('/api/coletor/parar', async () => { coletor.parar(); return coletor.state; });
  app.put<{ Body: { porHora: number } }>('/api/coletor/config', async (req) => {
    const { min, max, padrao } = coletor.POR_HORA;
    await setSetting('coleta.cvs_por_hora', Math.min(Math.max(Math.round(Number(req.body.porHora)) || padrao, min), max));
    return { ok: true };
  });
  // Chave vazia apaga a do painel (volta a valer a do .env, se houver).
  app.put<{ Body: { chave: string } }>('/api/coletor/2captcha', async (req, reply) => {
    const chave = String(req.body?.chave ?? '').trim();
    if (!chave) {
      await setSetting('coleta.twocaptcha_key', '');
      return { ok: true };
    }
    try {
      const s = await saldo(chave);
      await setSetting('coleta.twocaptcha_key', chave);
      return { ok: true, saldo: s };
    } catch (e) {
      return reply.code(400).send({ erro: `chave recusada pelo 2Captcha (${e instanceof Error ? e.message : e})` });
    }
  });
  app.post('/api/importar-pasta', async () => importarPasta());
  app.post('/api/reprocessar', async () => ({ reenfileirados: await reprocessar() }));

  // ───────────── Amostras: CVs com elementos sem parser, para baixar e virar exemplo ─────────────
  // O arquivo é o que foi parseado (XML se houver, senão HTML), cru como veio do Lattes.
  const arquivoDoCv = (id: string): string | null =>
    [xmlPathFor(id), htmlPathFor(id)].find((f) => fs.existsSync(f)) ?? null;
  const cvsComElemento = async (elemento: string) =>
    (await pool.query<{ id: string; nome: string | null }>(
      `SELECT l.pesquisador_id AS id, p.nome FROM parse_log l LEFT JOIN pesquisador p ON p.id = l.pesquisador_id
       WHERE l.desconhecidos ? $1 ORDER BY p.nome LIMIT 200`,
      [elemento],
    )).rows;
  app.get<{ Querystring: { elemento: string } }>('/api/desconhecidos/cvs', async (req) =>
    (await cvsComElemento(req.query.elemento ?? '')).map((c) => ({ ...c, arquivo: arquivoDoCv(c.id) ? path.extname(arquivoDoCv(c.id)!).slice(1) : null })),
  );
  app.get<{ Params: { id: string } }>('/api/cv/:id/arquivo', async (req, reply) => {
    if (!/^\d{16}$/.test(req.params.id)) return reply.code(400).send({ erro: 'ID Lattes inválido' });
    const f = arquivoDoCv(req.params.id);
    if (!f) return reply.code(404).send({ erro: 'arquivo do CV não está em disco' });
    return reply
      .header('Content-Type', f.endsWith('.xml') ? 'application/xml' : 'text/html; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${path.basename(f)}"`)
      .send(fs.createReadStream(f));
  });
  app.get<{ Querystring: { elemento: string } }>('/api/desconhecidos/zip', async (req, reply) => {
    const arquivos: Record<string, Uint8Array> = {};
    for (const c of await cvsComElemento(req.query.elemento ?? '')) {
      const f = arquivoDoCv(c.id);
      if (f) arquivos[path.basename(f)] = fs.readFileSync(f);
    }
    if (!Object.keys(arquivos).length) return reply.code(404).send({ erro: 'nenhum arquivo em disco para este elemento' });
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="amostras-${slug(req.query.elemento) || 'cvs'}.zip"`)
      .send(Buffer.from(zipSync(arquivos, { level: 6 })));
  });
  app.post('/api/backup', async () => fazerBackup());
  app.post('/api/exportar', async () => exportarParquet());
  app.get('/api/exportar', async () => {
    const dir = paths.exports();
    const arquivos = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.parquet')).map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { arquivo: f, bytes: st.size, em: st.mtime.toISOString() };
        })
      : [];
    return { dir, arquivos };
  });

  // ───────────── Busca ─────────────
  app.get('/api/facets', async () => {
    const [ufs, regioes, temas, tipos, insts, anos] = await Promise.all([
      pool.query(`SELECT uf AS v, count(*) n FROM pesquisador WHERE uf IS NOT NULL GROUP BY 1 ORDER BY 1`),
      pool.query(`SELECT regiao AS v, count(*) n FROM pesquisador WHERE regiao IS NOT NULL GROUP BY 1 ORDER BY 1`),
      pool.query(`SELECT g AS v, count(*) n FROM pesquisador, unnest(grandes_areas) g GROUP BY 1 ORDER BY 2 DESC LIMIT 60`),
      pool.query(`SELECT tipo AS v, count(*) n FROM obra GROUP BY 1 ORDER BY 2 DESC`),
      pool.query(`SELECT i.nome AS v, count(*) n FROM pesquisador p JOIN instituicao i ON i.id=p.instituicao_id GROUP BY 1 ORDER BY 2 DESC LIMIT 100`),
      pool.query(`SELECT min(ano) de, max(ano) ate FROM obra WHERE ano BETWEEN 1900 AND 2100`),
    ]);
    return { ufs: ufs.rows, regioes: regioes.rows, temas: temas.rows, tipos: tipos.rows, instituicoes: insts.rows, anos: anos.rows[0] };
  });

  app.get<{ Querystring: Q }>('/api/pesquisadores', async (req) => {
    const q = req.query;
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (v: unknown) => { args.push(v); return `$${args.length}`; };
    const tags = tagsDe(q);
    if (tags.length) where.push(`p.tags @> ${add(tags)}::text[]`);
    const nq = norm(q.q);
    let rank = '0::float8';
    if (nq) {
      const a = add(nq);
      where.push(`(p.nome_norm % ${a} OR p.nome_norm ILIKE '%' || ${a} || '%' OR p.tsv @@ plainto_tsquery('portuguese', ${a}))`);
      rank = `similarity(p.nome_norm, ${a})`;
    }
    const lim = intOr(q.limit, 30);
    const off = (intOr(q.page, 1, 1e6) - 1) * lim;
    const sql = `SELECT p.id, p.nome, p.uf, p.regiao, p.orcid, i.nome AS instituicao, p.grandes_areas, p.data_atualizacao_cv,
                   (SELECT count(*) FROM obra_fonte f WHERE f.pesquisador_id = p.id) AS obras, count(*) OVER() AS total
                 FROM pesquisador p LEFT JOIN instituicao i ON i.id = p.instituicao_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${rank} DESC, p.nome LIMIT ${lim} OFFSET ${off}`;
    const r = await pool.query(sql, args);
    return { total: Number(r.rows[0]?.total ?? 0), itens: r.rows.map(({ total, ...x }) => ({ ...x, obras: Number(x.obras) })) };
  });

  app.get<{ Params: { id: string } }>('/api/pesquisadores/:id', async (req, reply) => {
    const p = await pool.query(
      `SELECT p.*, i.nome AS instituicao FROM pesquisador p LEFT JOIN instituicao i ON i.id=p.instituicao_id WHERE p.id=$1`, [req.params.id]);
    if (!p.rows[0]) return reply.code(404).send({ erro: 'não encontrado' });
    const [obras, orient, colabs] = await Promise.all([
      pool.query(`SELECT o.id, o.tipo, o.titulo, o.ano, o.veiculo, o.doi FROM obra o JOIN obra_fonte f ON f.obra_id=o.id
                  WHERE f.pesquisador_id=$1 ORDER BY o.ano DESC NULLS LAST, o.titulo LIMIT 500`, [req.params.id]),
      pool.query(`SELECT orientado_nome, orientado_lattes_id, nivel, titulo, ano FROM orientacao WHERE orientador_id=$1 ORDER BY ano DESC NULLS LAST`, [req.params.id]),
      pool.query(`SELECT b.autor_lattes_id AS id, COALESCE(pp.nome, min(b.nome)) AS nome, count(*) AS obras
                  FROM autoria a JOIN autoria b ON b.obra_id=a.obra_id AND b.autor_lattes_id IS NOT NULL AND b.autor_lattes_id <> a.autor_lattes_id
                  LEFT JOIN pesquisador pp ON pp.id = b.autor_lattes_id
                  WHERE a.autor_lattes_id=$1 GROUP BY b.autor_lattes_id, pp.nome ORDER BY 3 DESC LIMIT 50`, [req.params.id]),
    ]);
    const { tsv, ...pesq } = p.rows[0];
    return { ...pesq, obras: obras.rows, orientacoes: orient.rows, colaboradores: colabs.rows.map((x) => ({ ...x, obras: Number(x.obras) })) };
  });

  app.get<{ Querystring: Q }>('/api/obras', async (req) => {
    const q = req.query;
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (v: unknown) => { args.push(v); return `$${args.length}`; };
    const tags = tagsDe(q);
    if (tags.length) where.push(`o.tags @> ${add(tags)}::text[]`);
    if (q.ano_de) where.push(`o.ano >= ${add(parseInt(q.ano_de, 10))}`);
    if (q.ano_ate) where.push(`o.ano <= ${add(parseInt(q.ano_ate, 10))}`);
    const nq = norm(q.q);
    let rank = '0::float8';
    if (nq) {
      const a = add(nq);
      where.push(`(o.tsv @@ plainto_tsquery('portuguese', ${a}) OR o.titulo_norm % ${a} OR o.titulo_norm ILIKE '%' || ${a} || '%')`);
      rank = `ts_rank(o.tsv, plainto_tsquery('portuguese', ${a})) + similarity(o.titulo_norm, ${a})`;
    }
    const lim = intOr(q.limit, 30);
    const off = (intOr(q.page, 1, 1e6) - 1) * lim;
    const r = await pool.query(
      `SELECT o.id, o.tipo, o.titulo, o.ano, o.veiculo, o.doi, o.palavras_chave,
         (SELECT string_agg(a.nome, '; ' ORDER BY a.ordem) FROM (SELECT nome, ordem FROM autoria WHERE obra_id=o.id ORDER BY ordem LIMIT 6) a) AS autores,
         count(*) OVER() AS total
       FROM obra o ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY ${rank} DESC, o.ano DESC NULLS LAST, o.id LIMIT ${lim} OFFSET ${off}`, args);
    return { total: Number(r.rows[0]?.total ?? 0), itens: r.rows.map(({ total, ...x }) => x) };
  });

  // ───────────── Grafo ─────────────
  // modo=colab: pesquisadores ligados por coautoria (peso = obras em comum) e orientação.
  // modo=obras: pesquisadores ↔ obras (bipartido), limitado às obras com mais coautores do filtro.
  app.get<{ Querystring: Q }>('/api/graph', async (req) => {
    const q = req.query;
    const limite = intOr(q.limit, 300, 2000);
    const tags = tagsDe(q);
    const filtro = q.q ? norm(q.q) : '';
    const base = `SELECT p.id FROM pesquisador p WHERE ($1::text[] = '{}' OR p.tags @> $1::text[])
                  AND ($2 = '' OR p.nome_norm % $2 OR p.nome_norm ILIKE '%' || $2 || '%')`;

    if (q.modo === 'obras') {
      const r = await pool.query(
        `WITH sel AS (${base}),
         o AS (SELECT f.obra_id, count(*) n FROM obra_fonte f JOIN sel ON sel.id=f.pesquisador_id GROUP BY 1 HAVING count(*) >= 2 ORDER BY 2 DESC LIMIT $3)
         SELECT f.obra_id, f.pesquisador_id, ob.titulo, ob.ano, ob.tipo, p.nome, p.regiao, p.uf
         FROM o JOIN obra_fonte f ON f.obra_id=o.obra_id JOIN obra ob ON ob.id=o.obra_id JOIN pesquisador p ON p.id=f.pesquisador_id
         WHERE f.pesquisador_id IN (SELECT id FROM sel)`,
        [tags, filtro, Math.max(10, Math.floor(limite / 3))],
      );
      const nodes = new Map<string, any>();
      const edges: { a: string; b: string; w: number }[] = [];
      for (const x of r.rows) {
        nodes.set(`p:${x.pesquisador_id}`, { id: `p:${x.pesquisador_id}`, label: x.nome, kind: 'pesquisador', grupo: x.regiao ?? 'sem região', uf: x.uf, lattesId: x.pesquisador_id });
        nodes.set(`o:${x.obra_id}`, { id: `o:${x.obra_id}`, label: x.titulo, kind: 'obra', grupo: x.tipo, ano: x.ano });
        edges.push({ a: `p:${x.pesquisador_id}`, b: `o:${x.obra_id}`, w: 1 });
      }
      return { nodes: [...nodes.values()], edges };
    }

    // Colaboradores: arestas de coautoria + orientação entre pesquisadores coletados do filtro.
    const e = await pool.query(
      `WITH sel AS (${base}),
       co AS (
         SELECT a.autor_lattes_id AS a, b.autor_lattes_id AS b, count(*) AS w
         FROM autoria a JOIN autoria b ON a.obra_id=b.obra_id AND a.autor_lattes_id < b.autor_lattes_id
         WHERE a.autor_lattes_id IN (SELECT id FROM sel) AND b.autor_lattes_id IN (SELECT id FROM sel)
         GROUP BY 1,2
       ), ori AS (
         SELECT orientador_id AS a, orientado_lattes_id AS b, count(*) AS w FROM orientacao
         WHERE orientado_lattes_id IS NOT NULL AND orientador_id IN (SELECT id FROM sel) AND orientado_lattes_id IN (SELECT id FROM sel)
         GROUP BY 1,2
       )
       SELECT a, b, w, 'coautoria' AS tipo FROM co UNION ALL SELECT least(a,b), greatest(a,b), w, 'orientacao' FROM ori
       ORDER BY w DESC LIMIT $3`,
      [tags, filtro, limite * 4],
    );
    const grau = new Map<string, number>();
    for (const x of e.rows) {
      grau.set(x.a, (grau.get(x.a) ?? 0) + Number(x.w));
      grau.set(x.b, (grau.get(x.b) ?? 0) + Number(x.w));
    }
    const top = new Set([...grau.entries()].sort((x, y) => y[1] - x[1]).slice(0, limite).map(([id]) => id));
    // Inclui também quem não tem aresta (até o limite), pra o filtro não "sumir" com gente.
    const soltos = await pool.query(`WITH sel AS (${base}) SELECT id FROM sel LIMIT $3`, [tags, filtro, limite]);
    for (const r of soltos.rows) if (top.size < limite) top.add(r.id);
    const ids = [...top];
    const ps = ids.length
      ? await pool.query(`SELECT p.id, p.nome, p.regiao, p.uf, i.nome AS instituicao FROM pesquisador p LEFT JOIN instituicao i ON i.id=p.instituicao_id WHERE p.id = ANY($1)`, [ids])
      : { rows: [] as any[] };
    return {
      nodes: ps.rows.map((p: any) => ({ id: p.id, label: p.nome, kind: 'pesquisador', grupo: p.regiao ?? 'sem região', uf: p.uf, instituicao: p.instituicao, lattesId: p.id })),
      edges: e.rows.filter((x: any) => top.has(x.a) && top.has(x.b)).map((x: any) => ({ a: x.a, b: x.b, w: Number(x.w), tipo: x.tipo })),
    };
  });
}
