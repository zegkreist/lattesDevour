#!/bin/sh
set -e
# Tela virtual + VNC + noVNC (porta 6080). O x11vnc só escuta dentro do container; quem
# expõe é o websockify, e o compose publica em 127.0.0.1.
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1366x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
sleep 1
if [ -n "$VNC_PASSWORD" ]; then
  x11vnc -storepasswd "$VNC_PASSWORD" /tmp/vncpass >/dev/null 2>&1
  AUTH="-rfbauth /tmp/vncpass"
else
  AUTH="-nopw"
fi
x11vnc -display :99 -forever -shared -localhost -rfbport 5900 $AUTH -quiet >/tmp/x11vnc.log 2>&1 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/tmp/websockify.log 2>&1 &
cd /app/server
exec node dist/index.js
