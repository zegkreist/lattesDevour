#!/bin/sh
set -e
# Container único: sobe o Postgres (só em localhost, dados em $PGDATA = ./data/pg no host)
# e depois o mesmo entrypoint do container app. No stop, para o app e então o banco.
POSTGRES_USER="${POSTGRES_USER:-lattes}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-lattes}"
POSTGRES_DB="${POSTGRES_DB:-lattes}"
export DATABASE_URL="${DATABASE_URL:-postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:5432/$POSTGRES_DB}"

pg() { setpriv --reuid=postgres --regid=postgres --init-groups "$@"; }

mkdir -p "$PGDATA" /var/run/postgresql
chown postgres:postgres "$PGDATA" /var/run/postgresql
chmod 700 "$PGDATA"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "$POSTGRES_PASSWORD" > /tmp/pgpass && chown postgres /tmp/pgpass
  pg initdb -D "$PGDATA" -U "$POSTGRES_USER" --pwfile=/tmp/pgpass \
    --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8 --locale=en_US.UTF-8 >/dev/null
  rm -f /tmp/pgpass
fi
if ! pg pg_ctl -D "$PGDATA" -w -t 120 -o "-c listen_addresses=localhost" -l /tmp/postgres.log start >/dev/null; then
  cat /tmp/postgres.log
  exit 1
fi
pg psql -U "$POSTGRES_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$POSTGRES_DB'" | grep -q 1 \
  || pg createdb -U "$POSTGRES_USER" "$POSTGRES_DB"

/entrypoint.sh &
APP=$!
trap 'kill -TERM "$APP" 2>/dev/null || true' TERM INT
set +e
wait "$APP"; STATUS=$?
# O primeiro wait volta quando chega o sinal; o segundo espera o app terminar de fato.
if kill -0 "$APP" 2>/dev/null; then wait "$APP"; STATUS=$?; fi
pg pg_ctl -D "$PGDATA" -m fast stop >/dev/null
exit $STATUS
