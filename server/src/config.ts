import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8080),
  databaseUrl: env.DATABASE_URL ?? 'postgres://lattes:lattes@localhost:5432/lattes',
  dataDir: env.DATA_DIR ?? path.resolve('data'),
  // Template da URL de download do XML (depois do captcha). O Lattes já mudou isso antes,
  // por isso é configurável sem rebuild.
  lattesDownloadUrl:
    env.LATTES_DOWNLOAD_URL ||
    'https://buscatextual.cnpq.br/buscatextual/download.do?metodo=apresentar&idcnpq={id}',
  // Seletor do botão que confirma o download depois do captcha (vazio = acha pelo texto).
  lattesSubmitSelector: env.LATTES_DOWNLOAD_SUBMIT ?? '',
  captchaTimeoutMs: Number(env.CAPTCHA_TIMEOUT_MS ?? 10 * 60_000),
  // Com chave, o captcha é resolvido pelo 2Captcha; sem chave, por uma pessoa via noVNC.
  twoCaptcha: {
    apiKey: env.TWOCAPTCHA_API_KEY ?? '',
    timeoutMs: Number(env.TWOCAPTCHA_TIMEOUT_MS ?? 3 * 60_000),
  },
  // O navegador do coletor precisa de tela (o captcha é resolvido por uma pessoa via noVNC).
  headless: env.COLLECTOR_HEADLESS === 'true',
  novncUrl: env.NOVNC_URL ?? 'http://localhost:6080/vnc.html?autoconnect=true&resize=scale',
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
  imports: () => path.join(config.dataDir, 'import'),
  backups: () => path.join(config.dataDir, 'backups'),
  browserProfile: () => path.join(config.dataDir, 'browser-profile'),
};
