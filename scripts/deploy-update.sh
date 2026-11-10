#!/usr/bin/env bash
# Update a remote Atlas install over SSH: backup, copy the code, rebuild, restart, report health.
# docs/DEPLOYMENT.md section 11. Never touches .env or certs on the server. Run from a checkout.
#
#   ATLAS_DEPLOY_HOST=unifi@192.168.1.77 ATLAS_DEPLOY_KEY=~/.ssh/atlas_deploy scripts/deploy-update.sh
#
# Optional: ATLAS_DEPLOY_DIR (default ~/atlas on the server). The TLS override file is added automatically
# when certs/fullchain.pem exists on the server (deploy/docker-compose.tls.yml, DEPLOYMENT.md section 8.3).
set -euo pipefail

HOST="${ATLAS_DEPLOY_HOST:?set ATLAS_DEPLOY_HOST, e.g. user@server}"
KEY="${ATLAS_DEPLOY_KEY:-$HOME/.ssh/id_ed25519}"
DIR="${ATLAS_DEPLOY_DIR:-atlas}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH=(ssh -i "$KEY" -o BatchMode=yes)

cd "$ROOT"
echo "== backup first"
"${SSH[@]}" "$HOST" "cd $DIR && docker compose -p atlas --env-file .env -f deploy/docker-compose.yml exec -T worker atlas-backup run 2>&1 | tail -2"

echo "== copy code (services, apps/web, deploy, scripts); .env and certs untouched"
for d in services apps/web deploy; do
  rsync -az --delete -e "ssh -i $KEY -o BatchMode=yes" \
    --exclude node_modules --exclude .venv --exclude __pycache__ --exclude '*cache*' --exclude '*.tsbuildinfo' \
    --exclude test-results --exclude playwright-report "./$d/" "$HOST:$DIR/$d/"
done

echo "== rebuild and restart"
"${SSH[@]}" "$HOST" "cd $DIR && TLS=''; [ -f certs/fullchain.pem ] && TLS='-f deploy/docker-compose.tls.yml'; \
  C=\"docker compose -p atlas --env-file .env -f deploy/docker-compose.yml \$TLS\"; \$C up -d --build 2>&1 | tail -6; sleep 12; \
  \$C ps --format '{{.Name}} {{.Status}} {{.Ports}}'; \$C exec -T api alembic current 2>&1 | tail -1; df -h / | tail -1"
echo "== done: check the health endpoint of your public base URL"
