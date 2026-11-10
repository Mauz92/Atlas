#!/usr/bin/env bash
# Issue (or renew) a Let's Encrypt certificate for a DuckDNS name with the DNS-01 challenge, and install it where
# deploy/docker-compose.tls.yml expects it. Atlas never has to be reachable from the internet for this.
# docs/DEPLOYMENT.md section 8.3. Run as the unprivileged deploy user on the server.
#
#   deploy/tls/issue-duckdns-cert.sh galaxia-atlas.duckdns.org [--staging]
#
# Needs: acme.sh in ~/.acme.sh and the DuckDNS token in ~/.acme-duckdns.env (mode 600) as
#   export DuckDNS_Token='<token>'
# (create it yourself; never paste the token into a chat, a ticket or a shell history).
set -euo pipefail

DOMAIN="${1:?usage: $0 <name.duckdns.org> [--staging]}"
STAGING=""
[ "${2:-}" = "--staging" ] && STAGING="--staging"

ACME="$HOME/.acme.sh/acme.sh"
TOKEN_FILE="$HOME/.acme-duckdns.env"
ATLAS_DIR="${ATLAS_DIR:-$HOME/atlas}"
CERT_DIR="${ATLAS_TLS_CERT_DIR:-$ATLAS_DIR/certs}"

[ -x "$ACME" ] || { echo "acme.sh not installed in ~/.acme.sh" >&2; exit 1; }
[ -f "$TOKEN_FILE" ] || { echo "missing $TOKEN_FILE (see the header of this script)" >&2; exit 1; }
[ "$(stat -c %a "$TOKEN_FILE")" = "600" ] || { echo "$TOKEN_FILE must be mode 600" >&2; exit 1; }
# shellcheck disable=SC1090
. "$TOKEN_FILE"
[ -n "${DuckDNS_Token:-}" ] || { echo "DuckDNS_Token is empty in $TOKEN_FILE" >&2; exit 1; }

mkdir -p "$CERT_DIR"
chmod 755 "$CERT_DIR"

# --force is needed only when switching between staging and production for the same name.
"$ACME" --issue --dns dns_duckdns -d "$DOMAIN" --server letsencrypt $STAGING --keylength ec-256 \
  ${ACME_FORCE:+--force} || [ $? -eq 2 ]   # exit 2 = "not due for renewal", not an error

# The reload command runs after every (re)issue, including the cron renewals.
"$ACME" --install-cert --ecc -d "$DOMAIN" \
  --fullchain-file "$CERT_DIR/fullchain.pem" \
  --key-file "$CERT_DIR/privkey.pem" \
  --reloadcmd "docker compose -p atlas --env-file $ATLAS_DIR/.env -f $ATLAS_DIR/deploy/docker-compose.yml -f $ATLAS_DIR/deploy/docker-compose.tls.yml restart web >/dev/null 2>&1 || true"

chmod 644 "$CERT_DIR/fullchain.pem"
chmod 640 "$CERT_DIR/privkey.pem"
echo "certificate for $DOMAIN installed in $CERT_DIR ${STAGING:+(STAGING: not trusted by browsers)}"
