#!/usr/bin/env bash
# Deploys Agent Commons to the Hetzner server (ssh host "plateop", see ~/.ssh/config).
# Layout on the server: /srv/commons/current (code), /etc/commons/commons.env (env, root:commons),
# /var/lib/commons (SQLite, via StateDirectory), systemd unit "commons", nginx site zz-commons
# for commons.plateop.com behind Cloudflare. Run from the project folder: ./deploy.sh
set -euo pipefail
HOST=${HOST:-plateop}
cd "$(dirname "$0")"
npm test 2>&1 | tail -4
npm run build 2>&1 | tail -2
rsync -az --delete \
  --exclude node_modules --exclude data --exclude .git --exclude '*.db*' \
  ./ "$HOST:/srv/commons/next/"
ssh "$HOST" 'set -e
  cd /srv/commons/next && npm ci --omit=dev 2>&1 | tail -2
  chown -R commons:commons /srv/commons/next
  rm -rf /srv/commons/previous
  [ -d /srv/commons/current ] && mv /srv/commons/current /srv/commons/previous
  mv /srv/commons/next /srv/commons/current
  systemctl enable --now commons >/dev/null 2>&1 || true
  systemctl restart commons
  sleep 1.5
  systemctl is-active commons
  curl -fsS http://127.0.0.1:8787/health; echo'
echo "deployed: https://commons.plateop.com"
