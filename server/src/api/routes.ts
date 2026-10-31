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
import { enfileirar, extrairIds, PRIORIDADE } from '../discovery/ids.js';
import { exportarParquet } from '../exportar.js';
import { limparBanco, senhaConfere } from '../limpar.js';
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

  // ───────────── Fila ─────────────
  // Aceita IDs soltos, lista do CNPq, URLs lattes.cnpq.br/<id>, CSV: qualquer texto com IDs de 16 dígitos.
  app.post<{ Body: { texto: string; origem?: string } }>('/api/fila/enfileirar', async (req) => {
    const ids = extrairIds(req.body.texto ?? '');
    return { encontrados: ids.length, novos: await enfileirar(ids, req.body.origem ?? 'lista') };
  });
  // ───────────── Coletar CVs pelo link ou ID (vão para o topo da fila) ─────────────
  const JA_COLETADO = ['parseado', 'html', 'baixado'];
  const EM_ANDAMENTO = ['baixando', 'aguardando_captcha'];
  type Acao = 'enfileirado' | 'em_andamento' | 'ja_coletado' | 'rede_priorizada';
  async function coletarId(id: string, rede: number, recoletar: boolean): Promise<Acao> {
    const atual = (await pool.query(`SELECT status, xml_path, html_path FROM fila WHERE lattes_id = $1`, [id])).rows[0];
    if (atual && EM_ANDAMENTO.includes(atual.status)) {
      if (rede) await pool.query(`UPDATE fila SET rede = GREATEST(rede, $2) WHERE lattes_id = $1`, [id, rede]);
      return 'em_andamento';
    }
    if (atual && JA_COLETADO.includes(atual.status) && !recoletar) {
      // Já está em disco: priorizar a rede não custa captcha, só reprocessa o arquivo.
      if (rede && (atual.xml_path || atual.html_path)) {
        await pool.query(
          `UPDATE fila SET rede = $2, status = CASE WHEN xml_path IS NOT NULL THEN 'baixado' ELSE 'html' END, atualizado_em = now() WHERE lattes_id = $1`,
          [id, rede],
        );
        return 'rede_priorizada';
      }
      return 'ja_coletado';
    }
    await pool.query(
      `INSERT INTO fila (lattes_id, origem, prioridade, rede) VALUES ($1, 'manual', $2, $3)
       ON CONFLICT (lattes_id) DO UPDATE SET status = 'pendente', prioridade = $2, rede = GREATEST(fila.rede, $3), tentativas = 0, ultimo_erro = NULL, atualizado_em = now()`,
      [id, PRIORIDADE.manual, rede],
    );
    return 'enfileirado';
  }
  // texto: um ou vários links/IDs, em qualquer formato (linhas, CSV, URLs soltas).
  app.post<{ Body: { texto: string; recoletar?: boolean; rede?: number } }>('/api/coletar', async (req, reply) => {
    const texto = String(req.body?.texto ?? '');
    const rede = Math.min(Math.max(Math.round(Number(req.body?.rede) || 0), 0), 2);
    const ids = extrairIds(texto);
    const comK = (texto.match(/id=K\w+/gi) ?? []).length;
    if (!ids.length) {
      const erro = comK
        ? 'os links usam o ID interno (K…), que só vira o ID Lattes depois do captcha. Abra o CV e copie o "Endereço para acessar este CV" (http://lattes.cnpq.br/ + 16 dígitos).'
        : 'não achei nenhum ID Lattes (16 dígitos). Use http://lattes.cnpq.br/<ID> ou só o ID.';
      return reply.code(400).send({ erro });
    }
    const itens: { id: string; acao: Acao }[] = [];
    for (const id of ids) itens.push({ id, acao: await coletarId(id, rede, !!req.body.recoletar) });
    return { itens, ignoradosK: comK };
  });
  // Situação de vários IDs de uma vez (o card acompanha a lista inteira).
  app.post<{ Body: { ids: string[] } }>('/api/coletar/status', async (req) => {
    const ids = (req.body?.ids ?? []).filter((x) => /^\d{16}$/.test(x)).slice(0, 500);
    const { rows } = await pool.query(
      `WITH ordem AS (
         SELECT lattes_id, row_number() OVER (ORDER BY prioridade DESC, criado_em, lattes_id) AS posicao FROM fila WHERE status = 'pendente')
       SELECT f.lattes_id AS id, f.status, f.ultimo_erro AS "ultimoErro", f.nome_hint AS "nomeHint", f.caminho,
              o.posicao::int, p.nome, (SELECT count(*) FROM obra_fonte x WHERE x.pesquisador_id = p.id)::int AS obras
       FROM fila f LEFT JOIN ordem o ON o.lattes_id = f.lattes_id LEFT JOIN pesquisador p ON p.id = f.lattes_id
       WHERE f.lattes_id = ANY($1)`,
      [ids],
    );
    const porId = new Map(rows.map((r) => [r.id, r]));
    const redeNaFila = Number((await pool.query(`SELECT count(*) FROM fila WHERE status = 'pendente' AND prioridade = $1`, [PRIORIDADE.rede])).rows[0].count);
    return { itens: ids.map((id) => porId.get(id) ?? { id, status: null }), coletorRodando: coletor.state.rodando, redeNaFila };
  });

  app.get<{ Querystring: Q }>('/api/fila', async (req) => {
    const { status } = req.query;
    const lim = intOr(req.query.limit, 50);
    const off = (intOr(req.query.page, 1, 1e6) - 1) * lim;
    const r = await pool.query(
      `SELECT f.lattes_id, f.status, f.origem, f.nome_hint, f.tentativas, f.ultimo_erro, f.atualizado_em
       FROM fila f
       WHERE ($1::text IS NULL OR f.status = $1) ORDER BY f.atualizado_em DESC LIMIT $2 OFFSET $3`,
      [status || null, lim, off],
    );
    return r.rows;
  });
  // Limpa só o que ainda não rodou ou falhou; o que está baixando ou já foi coletado fica (a linha da
  // fila é o elo com o arquivo em disco). Quem for citado de novo num CV volta a entrar sozinho.
  app.delete<{ Querystring: Q }>('/api/fila', async (req, reply) => {
    const status = req.query.status ?? 'pendente';
    if (!['pendente', 'erro', 'sem_cv'].includes(status)) return reply.code(400).send({ erro: 'só dá para limpar pendente, erro ou sem_cv' });
    const r = await pool.query(`DELETE FROM fila WHERE status = $1`, [status]);
    return { removidos: r.rowCount ?? 0 };
  });
  // CV com arquivo em disco que falhou no parse volta para o parse, não para o download
  // (baixar de novo gastaria um captcha à toa). Só vai para o download quem não tem arquivo.
  app.post('/api/fila/retry-erros', async () => {
    const r = await pool.query(
      `UPDATE fila SET status = CASE WHEN xml_path IS NOT NULL THEN 'baixado' WHEN html_path IS NOT NULL THEN 'html' ELSE 'pendente' END,
         tentativas = 0, ultimo_erro = NULL, atualizado_em = now()
       WHERE status IN ('erro', 'sem_cv') RETURNING status`,
    );
    const download = r.rows.filter((x) => x.status === 'pendente').length;
    return { reenfileirados: download, reprocessados: r.rows.length - download };
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
        caminho: await coletor.caminhoAtual(),
      },
      // Por onde os CVs vieram (para comparar os caminhos na fase de testes).
      porCaminho: Object.fromEntries(
        (await pool.query(`SELECT caminho, count(*)::int n FROM fila WHERE caminho IS NOT NULL GROUP BY 1`)).rows.map((r) => [r.caminho, r.n]),
      ),
    };
  });
  app.post('/api/coletor/iniciar', async () => { coletor.iniciar(); return coletor.state; });
  app.post('/api/coletor/parar', async () => { coletor.parar(); return coletor.state; });
  app.put<{ Body: { porHora?: number; caminho?: string } }>('/api/coletor/config', async (req) => {
    const { min, max, padrao } = coletor.POR_HORA;
    if (req.body.porHora !== undefined) {
      await setSetting('coleta.cvs_por_hora', Math.min(Math.max(Math.round(Number(req.body.porHora)) || padrao, min), max));
    }
    if (req.body.caminho !== undefined) await setSetting('coleta.caminho', req.body.caminho === 'previa' ? 'previa' : 'cv');
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
  // Zera o banco depois de uma cópia em Parquet; exige a senha do Postgres.
  app.post<{ Body: { senha?: string } }>('/api/db/limpar', async (req, reply) => {
    if (!senhaConfere(String(req.body?.senha ?? ''))) return reply.code(403).send({ erro: 'senha do banco incorreta' });
    try {
      return await limparBanco();
    } catch (e) {
      return reply.code(500).send({ erro: e instanceof Error ? e.message : String(e) });
    }
  });
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

  // ───────────── Próximos: quem ainda não foi coletado mas está colado na rede de quem já foi ─────────────
  // As sementes são os pesquisadores coletados que passam no filtro (mesmos filtros do grafo); o
  // candidato é qualquer ID Lattes que aparece com eles em autoria ou orientação e ainda não tem CV
  // coletado. `vinculos` = quantos pesquisadores da rede o citam; `obras` = obras em comum somadas.
  app.get<{ Querystring: Q }>('/api/proximos', async (req) => {
    const q = req.query;
    const tags = tagsDe(q);
    const filtro = q.q ? norm(q.q) : '';
    const lim = intOr(q.limit, 50);
    const off = (intOr(q.page, 1, 1e6) - 1) * lim;
    const r = await pool.query(
      `WITH sel AS (
         SELECT p.id FROM pesquisador p WHERE ($1::text[] = '{}' OR p.tags @> $1::text[])
           AND ($2 = '' OR p.nome_norm % $2 OR p.nome_norm ILIKE '%' || $2 || '%')
       ), lig AS (
         SELECT b.autor_lattes_id AS id, b.nome, a.autor_lattes_id AS pid, 1 AS w
         FROM autoria a JOIN autoria b ON b.obra_id = a.obra_id AND b.autor_lattes_id IS NOT NULL AND b.autor_lattes_id <> a.autor_lattes_id
         WHERE a.autor_lattes_id IN (SELECT id FROM sel) AND NOT EXISTS (SELECT 1 FROM pesquisador x WHERE x.id = b.autor_lattes_id)
         UNION ALL
         SELECT o.orientado_lattes_id, o.orientado_nome, o.orientador_id, 1
         FROM orientacao o WHERE o.orientador_id IN (SELECT id FROM sel) AND o.orientado_lattes_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM pesquisador x WHERE x.id = o.orientado_lattes_id)
       ), agg AS (
         SELECT id, min(nome) AS nome, count(DISTINCT pid) AS vinculos, sum(w) AS ligacoes,
                (array_agg(DISTINCT pid))[1:3] AS amostra
         FROM lig GROUP BY id
       )
       SELECT g.id, g.nome, g.vinculos, g.ligacoes, f.status AS fila,
              (SELECT array_agg(p.nome) FROM pesquisador p WHERE p.id = ANY(g.amostra)) AS ligado_a,
              count(*) OVER() AS total
       FROM agg g LEFT JOIN fila f ON f.lattes_id = g.id
       ORDER BY g.vinculos DESC, g.ligacoes DESC, g.nome LIMIT ${lim} OFFSET ${off}`,
      [tags, filtro],
    );
    return {
      total: Number(r.rows[0]?.total ?? 0),
      itens: r.rows.map(({ total, ...x }) => ({ ...x, vinculos: Number(x.vinculos), ligacoes: Number(x.ligacoes) })),
    };
  });

  // ───────────── Grafo ─────────────
  // A rede nasce do filtro: o resultado da busca são as sementes e o grafo se expande `niveis`
  // saltos (coautoria + orientação) a partir delas, incluindo quem não foi coletado (só tem ID).
  // niveis=0 reproduz o antigo "só quem passa no filtro".
  // modo=colab: pesquisadores ligados por coautoria (peso = obras em comum) e orientação.
  // modo=obras: pesquisadores ↔ obras (bipartido), só obras com ≥2 pesquisadores da rede.
  app.get<{ Querystring: Q }>('/api/graph', async (req) => {
    const q = req.query;
    const limite = intOr(q.limit, 300, 2000);
    const niveis = Math.min(Math.max(parseInt(q.niveis ?? '', 10) || 0, 0), 3);
    const sementes = niveis === 0 ? limite : intOr(q.sementes, 30, limite);
    const tags = tagsDe(q);
    const filtro = q.q ? norm(q.q) : '';

    const sem = await pool.query(
      `SELECT p.id FROM pesquisador p WHERE ($1::text[] = '{}' OR p.tags @> $1::text[])
         AND ($2 = '' OR p.nome_norm % $2 OR p.nome_norm ILIKE '%' || $2 || '%')
       ORDER BY CASE WHEN $2 = '' THEN 0 ELSE similarity(p.nome_norm, $2) END DESC,
                (SELECT count(*) FROM obra_fonte f WHERE f.pesquisador_id = p.id) DESC, p.nome
       LIMIT $3`,
      [tags, filtro, sementes],
    );
    const nivel = new Map<string, number>(sem.rows.map((r: any) => [r.id as string, 0]));
    let fronteira = [...nivel.keys()];
    for (let n = 1; n <= niveis && fronteira.length && nivel.size < limite; n++) {
      const viz = await pool.query(
        `SELECT id, sum(w) AS w FROM (
           SELECT b.autor_lattes_id AS id, count(*) AS w FROM autoria a
             JOIN autoria b ON b.obra_id = a.obra_id AND b.autor_lattes_id IS NOT NULL AND b.autor_lattes_id <> a.autor_lattes_id
             WHERE a.autor_lattes_id = ANY($1) GROUP BY 1
           UNION ALL SELECT orientado_lattes_id, count(*) FROM orientacao WHERE orientador_id = ANY($1) AND orientado_lattes_id IS NOT NULL GROUP BY 1
           UNION ALL SELECT orientador_id, count(*) FROM orientacao WHERE orientado_lattes_id = ANY($1) GROUP BY 1
         ) x WHERE id <> ALL($2) GROUP BY id ORDER BY 2 DESC LIMIT $3`,
        [fronteira, [...nivel.keys()], limite - nivel.size],
      );
      fronteira = viz.rows.map((r: any) => r.id as string);
      for (const id of fronteira) nivel.set(id, n);
    }
    const ids = [...nivel.keys()];
    if (!ids.length) return { nodes: [], edges: [] };

    // Pesquisadores coletados trazem região/instituição; os demais só o nome que aparece nas autorias.
    const ps = await pool.query(
      `SELECT u.id, COALESCE(p.nome, (SELECT min(nome) FROM autoria WHERE autor_lattes_id = u.id)) AS nome,
              p.regiao, p.uf, i.nome AS instituicao, p.id IS NOT NULL AS coletado,
              o.id IS NOT NULL AS orientador, o.pos_doutorado, o.doutorado, o.mestrado, o.outras
       FROM unnest($1::text[]) u(id) LEFT JOIN pesquisador p ON p.id = u.id LEFT JOIN instituicao i ON i.id = p.instituicao_id
       LEFT JOIN orientador o ON o.id = u.id`,
      [ids],
    );
    // classe: orientador (tem orientações no próprio CV) ou pesquisador; a cor continua sendo a região.
    const pessoa = (p: any) => ({
      id: p.id, label: p.nome ?? p.id, kind: 'pesquisador', grupo: p.regiao ?? (p.coletado ? 'sem região' : 'não coletado'),
      classe: p.orientador ? 'orientador' : 'pesquisador',
      orientacoes: p.orientador ? { pos_doutorado: p.pos_doutorado, doutorado: p.doutorado, mestrado: p.mestrado, outras: p.outras } : undefined,
      uf: p.uf, instituicao: p.instituicao, lattesId: p.coletado ? p.id : undefined, nivel: nivel.get(p.id),
    });

    if (q.modo === 'obras') {
      const r = await pool.query(
        `WITH o AS (SELECT obra_id, count(DISTINCT autor_lattes_id) n FROM autoria WHERE autor_lattes_id = ANY($1)
                    GROUP BY 1 HAVING count(DISTINCT autor_lattes_id) >= 2 ORDER BY 2 DESC LIMIT $2)
         SELECT DISTINCT a.obra_id, a.autor_lattes_id, ob.titulo, ob.ano, ob.tipo
         FROM o JOIN autoria a ON a.obra_id = o.obra_id JOIN obra ob ON ob.id = o.obra_id
         WHERE a.autor_lattes_id = ANY($1)`,
        [ids, Math.max(10, Math.floor(limite / 3))],
      );
      const nodes = new Map<string, any>();
      const edges: { a: string; b: string; w: number }[] = [];
      for (const p of ps.rows) nodes.set(`p:${p.id}`, { ...pessoa(p), id: `p:${p.id}` });
      for (const x of r.rows) {
        nodes.set(`o:${x.obra_id}`, { id: `o:${x.obra_id}`, label: x.titulo, kind: 'obra', grupo: x.tipo, ano: x.ano });
        edges.push({ a: `p:${x.autor_lattes_id}`, b: `o:${x.obra_id}`, w: 1 });
      }
      // Só fica quem se liga a alguma obra.
      const usados = new Set(edges.flatMap((e) => [e.a, e.b]));
      return { nodes: [...nodes.values()].filter((n) => usados.has(n.id)), edges };
    }

    // Colaboradores: arestas de coautoria + orientação entre quem está na rede.
    const e = await pool.query(
      `WITH co AS (
         SELECT a.autor_lattes_id AS a, b.autor_lattes_id AS b, count(*) AS w
         FROM autoria a JOIN autoria b ON a.obra_id=b.obra_id AND a.autor_lattes_id < b.autor_lattes_id
         WHERE a.autor_lattes_id = ANY($1) AND b.autor_lattes_id = ANY($1)
         GROUP BY 1,2
       ), ori AS (
         SELECT orientador_id AS a, orientado_lattes_id AS b, count(*) AS w FROM orientacao
         WHERE orientado_lattes_id = ANY($1) AND orientador_id = ANY($1)
         GROUP BY 1,2
       )
       SELECT a, b, w, 'coautoria' AS tipo FROM co UNION ALL SELECT least(a,b), greatest(a,b), w, 'orientacao' FROM ori
       ORDER BY w DESC LIMIT $2`,
      [ids, limite * 8],
    );
    return {
      nodes: ps.rows.map(pessoa),
      edges: e.rows.map((x: any) => ({ a: x.a, b: x.b, w: Number(x.w), tipo: x.tipo })),
    };
  });
}
