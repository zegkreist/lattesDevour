#!/bin/sh
set -e
# Começa como root só para acertar o dono de /data (o Docker cria bind mounts inexistentes
# como root) e então vira PUID:PGID (seu uid/gid no host) para tudo o mais.
PUID="${LATTES_UID:-1000}"
PGID="${LATTES_GID:-1000}"
mkdir -p /data/xml /data/import /data/backups /data/browser-profile
chown "$PUID:$PGID" /data /data/xml /data/import /data/backups /data/browser-profile
exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups /run.sh
