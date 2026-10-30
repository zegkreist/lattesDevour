import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8080),
  databaseUrl: env.DATABASE_URL ?? 'postgres://lattes:lattes@localhost:5432/lattes',
  dataDir: env.DATA_DIR ?? path.resolve('data'),
  // Página pública do CV ({id} = ID Lattes de 16 dígitos): redireciona para visualizacv.do,
  // que pede reCAPTCHA v2. Configurável sem rebuild caso o Lattes mude.
  lattesCvUrl: env.LATTES_CV_URL || 'https://buscatextual.cnpq.br/buscatextual/cv?id={id}',
  // Prévia do resultado da busca ({k} = ID interno K…); o abreCV() dela abre o CV com reCAPTCHA v3.
  lattesPreviaUrl: env.LATTES_PREVIA_URL || 'https://buscatextual.cnpq.br/buscatextual/preview.do?metodo=apresentar&id={k}',
  captchaTimeoutMs: Number(env.CAPTCHA_TIMEOUT_MS ?? 10 * 60_000),
  // Com chave, o captcha é resolvido pelo 2Captcha; sem chave, por uma pessoa via noVNC.
  twoCaptcha: {
    apiKey: env.TWOCAPTCHA_API_KEY ?? '',
    timeoutMs: Number(env.TWOCAPTCHA_TIMEOUT_MS ?? 3 * 60_000),
  },
  // O navegador do coletor precisa de tela (o captcha é resolvido por uma pessoa via noVNC).
  headless: env.COLLECTOR_HEADLESS === 'true',
  // Vazio = o painel monta o link com o host em que foi aberto, porta 6080 (ex.: no NAS).
  novncUrl: env.NOVNC_URL || '',
  backup: {
    s3Bucket: env.BACKUP_S3_BUCKET ?? '',
    s3Prefix: env.BACKUP_S3_PREFIX ?? 'lattes-devour/',
    s3Region: env.AWS_REGION ?? 'sa-east-1',
    keep: Number(env.BACKUP_KEEP ?? 7),
    // Horário de Brasília. 0 = desliga o agendamento (backup manual continua disponível).
    hour: Number(env.BACKUP_HOUR ?? 3),
  },
  tz: 'America/Sao_Paulo',
};

export const paths = {
  xml: () => path.join(config.dataDir, 'xml'),
  html: () => path.join(config.dataDir, 'html'),
  exports: () => path.join(config.dataDir, 'exports'),
  duckdbExt: () => path.join(config.dataDir, 'duckdb-ext'),
  imports: () => path.join(config.dataDir, 'import'),
  backups: () => path.join(config.dataDir, 'backups'),
  browserProfile: () => path.join(config.dataDir, 'browser-profile'),
};
