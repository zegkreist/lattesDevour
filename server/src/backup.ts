import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { config, paths } from './config.js';
import { pool } from './db.js';
import { exportarParquet } from './exportar.js';

// Backup = pg_dump (formato custom) + tarball dos XMLs crus (recoletar custa um captcha por
// CV, então os XMLs valem tanto quanto o banco). Grava em data/backups no host e, se
// BACKUP_S3_BUCKET estiver definido, sobe para o S3. Credenciais AWS pelo ambiente.
const stamp = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: config.tz, dateStyle: 'short', timeStyle: 'medium' })
    .format(new Date())
    .replace(/[: ]/g, '-');

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: ['ignore', 'inherit', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} saiu com ${code}: ${err.slice(-400)}`))));
  });
}

async function subirS3(file: string): Promise<string> {
  const { s3Bucket, s3Prefix, s3Region } = config.backup;
  const key = `${s3Prefix}${path.basename(file)}`;
  await new Upload({
    client: new S3Client({ region: s3Region }),
    params: { Bucket: s3Bucket, Key: key, Body: fs.createReadStream(file) },
  }).done();
  return `s3://${s3Bucket}/${key}`;
}

export async function fazerBackup(): Promise<{ arquivos: string[]; destino: string }> {
  fs.mkdirSync(paths.backups(), { recursive: true });
  const ts = stamp();
  const dump = path.join(paths.backups(), `lattes-${ts}.dump`);
  const xmls = path.join(paths.backups(), `xml-${ts}.tar.gz`);
  const arquivos: string[] = [];
  let destino = 'local';
  try {
    const u = new URL(config.databaseUrl);
    await run('pg_dump', ['-Fc', '-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username), '-d', u.pathname.slice(1), '-f', dump], {
      ...process.env,
      PGPASSWORD: decodeURIComponent(u.password),
    });
    arquivos.push(dump);
    if (fs.existsSync(paths.xml())) {
      await run('tar', ['-czf', xmls, '-C', path.dirname(paths.xml()), path.basename(paths.xml())]);
      arquivos.push(xmls);
    }
    if (config.backup.s3Bucket) {
      for (const f of arquivos) destino = await subirS3(f);
    }
    for (const f of arquivos) {
      await pool.query(`INSERT INTO backup_log (arquivo, bytes, destino, ok) VALUES ($1,$2,$3,true)`, [path.basename(f), fs.statSync(f).size, destino]);
    }
    podar();
    return { arquivos, destino };
  } catch (e) {
    await pool.query(`INSERT INTO backup_log (arquivo, destino, ok, erro) VALUES ($1,$2,false,$3)`, [path.basename(dump), destino, String(e).slice(0, 400)]);
    throw e;
  }
}

function podar(): void {
  for (const prefixo of ['lattes-', 'xml-']) {
    const files = fs.readdirSync(paths.backups()).filter((f) => f.startsWith(prefixo)).sort().reverse();
    for (const f of files.slice(config.backup.keep)) fs.rmSync(path.join(paths.backups(), f));
  }
}

/** Agenda diário no horário de Brasília (BACKUP_HOUR; 0 desliga): backup e cópia em Parquet. */
export function agendarBackup(): void {
  if (!config.backup.hour) return;
  let ultimoDia = '';
  setInterval(async () => {
    const f = new Intl.DateTimeFormat('sv-SE', { timeZone: config.tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date());
    const [dia, hora] = f.split(' ');
    if (Number(hora.split(':')[0]) !== config.backup.hour || dia === ultimoDia) return;
    ultimoDia = dia;
    await fazerBackup().catch((e) => console.error('backup agendado falhou:', e));
    await exportarParquet().catch((e) => console.error('exportação Parquet agendada falhou:', e));
  }, 60_000).unref();
}
