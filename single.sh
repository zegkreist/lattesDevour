#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# single.sh — sobe o lattesDevour inteiro (Postgres + API + painel + coletor + noVNC)
# num container só. Usa os mesmos dados do compose: ./data/app e ./data/pg.
#
# Uso:
#   ./single.sh                                # build local (Dockerfile, target single)
#   ./single.sh zegkreist/lattesdevour:latest  # usa a imagem do Docker Hub (pull)
#   ./single.sh --stop                         # para e remove o container
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

NOME="lattesdevour"

if [[ "${1:-}" == "--stop" ]]; then
  docker rm -f "$NOME" >/dev/null 2>&1 && echo "✅ $NOME parado" || echo "$NOME não estava rodando"
  exit 0
fi
IMAGEM="${1:-lattesdevour:single}"

if [[ ! -f .env ]]; then
  cp .env.example .env
  sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/; s/^LATTES_UID=.*/LATTES_UID=$(id -u)/; s/^LATTES_GID=.*/LATTES_GID=$(id -g)/" .env
  echo "▶ .env criado a partir do .env.example"
fi
set -a; . ./.env; set +a
APP_PORT="${APP_PORT:-8080}"
NOVNC_PORT="${NOVNC_PORT:-6080}"

# Compose e container único abrem o mesmo ./data/pg: nunca os dois ao mesmo tempo.
if [[ -n "$(docker compose ps -q 2>/dev/null)" ]]; then
  echo "▶ Parando a stack do compose (os dados ficam em ./data)…"
  docker compose down
fi

if [[ "$IMAGEM" == "lattesdevour:single" ]]; then
  echo "▶ Build de $IMAGEM…"
  docker build --target single -t "$IMAGEM" .
else
  echo "▶ Pull de $IMAGEM…"
  docker pull "$IMAGEM"
fi

docker rm -f "$NOME" >/dev/null 2>&1 || true
echo "▶ Subindo $NOME…"
docker run -d --name "$NOME" \
  --restart unless-stopped --stop-timeout 30 --shm-size 1g \
  --env-file .env \
  -e NOVNC_URL="http://localhost:${NOVNC_PORT}/vnc.html?autoconnect=true&resize=scale" \
  -e TZ=America/Sao_Paulo \
  -p "127.0.0.1:${APP_PORT}:8080" -p "127.0.0.1:${NOVNC_PORT}:6080" \
  -v "$PWD/data/app:/data" \
  -v "$PWD/data/pg:/var/lib/postgresql/data" \
  "$IMAGEM" >/dev/null

for _ in $(seq 1 60); do
  if curl -sf -m 3 "http://127.0.0.1:${APP_PORT}/api/coletor" >/dev/null; then
    echo ""
    echo "✅ No ar"
    echo "   Painel:                  http://localhost:${APP_PORT}"
    echo "   Navegador do coletor:    http://localhost:${NOVNC_PORT}/vnc.html?autoconnect=true&resize=scale"
    echo "   Logs:                    docker logs -f $NOME"
    exit 0
  fi
  sleep 2
done
echo "❌ O app não respondeu em 2 min. Últimas linhas do log:"
docker logs --tail 40 "$NOME"
exit 1
