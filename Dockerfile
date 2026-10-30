# ---------- build do front ----------
FROM node:22-trixie-slim AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---------- build do servidor ----------
FROM node:22-trixie-slim AS server
WORKDIR /server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ---------- runtime (container "app" do compose) ----------
FROM node:22-trixie-slim AS app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright TZ=America/Sao_Paulo HOME=/tmp DISPLAY=:99
# xvfb+x11vnc+novnc: o Chromium do coletor precisa de tela porque o captcha é resolvido por uma pessoa.
# postgresql-client: pg_dump do backup (versão do cliente >= versão do servidor).
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify postgresql-client tar ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /server/node_modules ./server/node_modules
COPY --from=server /server/dist ./server/dist
COPY --from=server /server/package.json ./server/package.json
COPY server/migrations ./server/migrations
COPY --from=web /web/dist ./web/dist
RUN cd server && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* && chmod -R a+rX /ms-playwright
COPY docker/entrypoint.sh docker/run.sh /
RUN chmod +x /entrypoint.sh /run.sh
ENV WEB_DIR=/app/web/dist DATA_DIR=/data
EXPOSE 8080 6080
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]

# ---------- tudo num container só: app + Postgres (./single.sh) ----------
FROM app AS single
# Usuário postgres com uid/gid 999 e locale en_US.UTF-8, como na imagem oficial postgres:17:
# assim o container único abre o mesmo ./data/pg que o compose criou.
RUN groupadd -r -g 999 postgres && useradd -r -g postgres -u 999 -d /var/lib/postgresql -s /bin/sh postgres \
    && mkdir -p /etc/postgresql-common && echo 'create_main_cluster = false' > /etc/postgresql-common/createcluster.conf \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-17 locales \
    && sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen && locale-gen \
    && rm -rf /var/lib/apt/lists/*
ENV PATH=/usr/lib/postgresql/17/bin:$PATH PGDATA=/var/lib/postgresql/data
COPY docker/single-entrypoint.sh /
RUN chmod +x /single-entrypoint.sh
ENTRYPOINT ["/usr/bin/tini", "--", "/single-entrypoint.sh"]
