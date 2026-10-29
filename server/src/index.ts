import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { rotas } from './api/routes.js';
import { agendarBackup } from './backup.js';
import { importarPasta, parsePending } from './collector/pipeline.js';
import { config, paths } from './config.js';
import { migrate, pool } from './db.js';
import './parsers/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  for (const d of [paths.xml(), paths.imports(), paths.backups()]) fs.mkdirSync(d, { recursive: true });

  // O DB sobe em paralelo no compose; espera até aceitar conexão.
  for (let i = 0; ; i++) {
    try { await pool.query('SELECT 1'); break; } catch (e) {
      if (i > 60) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const aplicadas = await migrate();
  if (aplicadas.length) console.log('migrações aplicadas:', aplicadas.join(', '));

  const app = Fastify({ logger: { level: 'info' }, bodyLimit: 200 * 1024 * 1024 });
  await app.register(rotas);
  const web = process.env.WEB_DIR ?? path.resolve(here, '../../web/dist');
  if (fs.existsSync(web)) {
    await app.register(fastifyStatic, { root: web });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api') ? reply.code(404).send({ erro: 'não encontrado' }) : reply.sendFile('index.html')));
  }
  await app.listen({ port: config.port, host: '0.0.0.0' });

  // Parse contínuo do que foi baixado + varredura da pasta de import (Extrator do CNPq).
  setInterval(() => void parsePending().catch((e) => console.error('parse:', e)), 2000).unref();
  setInterval(() => void importarPasta().catch((e) => console.error('import:', e)), 30_000).unref();
  agendarBackup();
}

main().catch((e) => { console.error(e); process.exit(1); });
