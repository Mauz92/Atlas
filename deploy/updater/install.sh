#!/usr/bin/env bash
# One-time setup of the host updater (docs/DEPLOYMENT.md section 12). Run on the server, from the install directory,
# as the user that runs Docker:   sudo -v && deploy/updater/install.sh
# It creates update/, the token file template and the systemd units. It never reads or prints a token.
set -euo pipefail
INSTALL="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"
[ "$RUN_USER" != root ] || { echo "run as the user that runs Docker, not as root (sudo is used where needed)"; exit 1; }
id -nG "$RUN_USER" | grep -qw docker || { echo "$RUN_USER is not in the docker group"; exit 1; }

# The API container runs as uid 10001; it must write request.json here, and this user must read it.
sudo install -d -o 10001 -g "$(id -gn "$RUN_USER")" -m 2775 "$INSTALL/update"
cfg="$HOME/.config/atlas-updater"
install -d -m 700 "$cfg"
if [ ! -f "$cfg/env" ]; then
  cat > "$cfg/env" <<'ENV'
# Owner-only. A GitHub personal access token that can read this repository's releases and packages
# (classic token with: repo, read:packages). It is used only by the updater on this host.
ATLAS_UPDATE_TOKEN=
ATLAS_UPDATE_USER=Mauz92
ATLAS_UPDATE_REPO=Mauz92/atlas
ATLAS_IMAGE_REGISTRY=ghcr.io/mauz92
ENV
  chmod 600 "$cfg/env"
  echo "Edit $cfg/env and set ATLAS_UPDATE_TOKEN (nobody else should see it)."
fi

for unit in atlas-updater.service atlas-updater.path atlas-updater-check.service atlas-updater-check.timer; do
  sed -e "s#@USER@#$RUN_USER#g" -e "s#@INSTALL@#$INSTALL#g" "$INSTALL/deploy/updater/$unit" | sudo tee "/etc/systemd/system/$unit" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now atlas-updater.path atlas-updater-check.timer
echo "Installed. First update (switches this install from a source build to release images):"
echo "  python3 $INSTALL/deploy/updater/atlas_updater.py apply"
