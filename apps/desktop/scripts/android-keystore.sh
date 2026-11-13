#!/usr/bin/env bash
# Create the signing key of the Android app (once). The key identifies YOUR builds: an update is only accepted by Android when it is
# signed with the same key, so keep keys/ safe and backed up (never commit it: it is gitignored). Losing it means uninstalling the app
# (and re-syncing from the server) to install a build signed with a new key.
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME="${JAVA_HOME:-$HOME/.local/android/jdk17}"
KEYTOOL="$JAVA_HOME/bin/keytool"
mkdir -p keys
chmod 700 keys
JKS=keys/atlas-android.jks
PROPS=keys/android-signing.properties
if [ -f "$JKS" ]; then echo "keys/atlas-android.jks already exists: not touching it"; exit 0; fi
PASS="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
"$KEYTOOL" -genkeypair -keystore "$JKS" -storetype PKCS12 -storepass "$PASS" -keypass "$PASS" \
  -alias atlas -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=Atlas (self-hosted), O=Atlas" >/dev/null
umask 077
printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=atlas\nkeyPassword=%s\n' "$PWD/$JKS" "$PASS" "$PASS" > "$PROPS"
chmod 600 "$JKS" "$PROPS"
echo "created $JKS and $PROPS. Back both up somewhere safe."
"$KEYTOOL" -list -keystore "$JKS" -storepass "$PASS" | tail -3
