#!/usr/bin/env bash
# deploy-wsl-runtime.sh — rebuild the WSL runtime archive from this checkout and
# stage it into the installed Windows T3 Code app.
#
# WHY THIS EXISTS: the Windows desktop app runs its server INSIDE WSL. It ships
# resources/wsl-runtime.tar.gz, verifies the bytes against the recorded sha256,
# extracts to ~/.t3/wsl-runtime/sha256-<archive-digest>/, and records the sha256
# of apps/server/dist/bin.mjs in a ready marker. Everything in apps/server/dist
# (server AND the inlined web client) therefore ships in that one archive, so a
# server/web change can be deployed by swapping it — no Windows installer, no
# MSVC/wine toolchain, which cannot be run from WSL anyway.
#
# The swap is INERT until the app is relaunched: the running server keeps using
# its already-extracted runtime directory.
#
# CAVEAT: the app auto-updates from whatever repo resources/app-update.yml names.
# While that stays pingdotgg/t3code, an upstream release replaces resources/ and
# reverts this deploy — re-run this script after any upstream update.
#
# USAGE:
#   scripts/admera/deploy-wsl-runtime.sh                 # build, back up, deploy
#   scripts/admera/deploy-wsl-runtime.sh --archive-only  # build archive, don't deploy
#   scripts/admera/deploy-wsl-runtime.sh --rollback      # restore the newest backup
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
T3_HOME="${T3CODE_HOME:-$HOME/.t3}"
RUNTIME_PARENT="$T3_HOME/wsl-runtime"
WIN_RESOURCES="${T3CODE_WIN_RESOURCES:-/mnt/c/Users/$(cmd.exe /c 'echo %USERNAME%' 2>/dev/null | tr -d '\r')/AppData/Local/Programs/t3code/resources}"
ARCHIVE_NAME="wsl-runtime.tar.gz"
BACKUP_DIR="$HOME/t3code-deploy-backup-$(date +%F)"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }

# The archive's node_modules holds prebuilt LINUX native binaries (node-pty,
# ffi-rs, msgpackr-extract). They are not reproducible from the repo's pnpm
# symlink farm, so they are lifted from an already-installed runtime instead.
find_reference_runtime() {
  local newest=""
  for d in "$RUNTIME_PARENT"/sha256-*; do
    [ -d "$d/node_modules" ] || continue
    [ -z "$newest" ] && newest="$d"
    [ "$d" -nt "$newest" ] && newest="$d"
  done
  printf '%s' "$newest"
}

rollback() {
  local newest_backup
  newest_backup="$(ls -1d "$HOME"/t3code-deploy-backup-* 2>/dev/null | tail -1)"
  [ -n "$newest_backup" ] || die "no backup directory found under $HOME"
  [ -f "$newest_backup/$ARCHIVE_NAME" ] || die "backup is missing $ARCHIVE_NAME"
  cp -a "$newest_backup/$ARCHIVE_NAME" "$WIN_RESOURCES/$ARCHIVE_NAME"
  cp -a "$newest_backup/$ARCHIVE_NAME.sha256" "$WIN_RESOURCES/$ARCHIVE_NAME.sha256"
  printf 'restored from %s (digest %s)\n' "$newest_backup" "$(cut -c1-16 <"$WIN_RESOURCES/$ARCHIVE_NAME.sha256")"
  exit 0
}

case "${1:-}" in
  --rollback) rollback ;;
esac

ARCHIVE_ONLY=0
[ "${1:-}" = "--archive-only" ] && ARCHIVE_ONLY=1

cd "$REPO_DIR"
[ -f apps/server/dist/bin.mjs ] || die "apps/server/dist/bin.mjs missing — run 'npm run build' first"

REFERENCE="$(find_reference_runtime)"
[ -n "$REFERENCE" ] || die "no installed runtime under $RUNTIME_PARENT to source node_modules from; launch the app once first"

STAGE="$(mktemp -d)"
OUT="$(mktemp -d)"
trap 'rm -rf "$STAGE" "$OUT"' EXIT

mkdir -p "$STAGE/apps/server"
cp -a apps/server/dist "$STAGE/apps/server/dist"
cp -a "$REFERENCE/node_modules" "$STAGE/node_modules"

# Member roots must be exactly apps/... and node_modules/... (no ./ prefix) to
# match the layout the app's extractor expects.
tar -C "$STAGE" -czf "$OUT/$ARCHIVE_NAME" apps/server/dist node_modules
DIGEST="$(sha256sum "$OUT/$ARCHIVE_NAME" | cut -d' ' -f1)"

# The installer hard-fails without the Linux node-pty binary; catch that here
# rather than after the app refuses to start its backend. The listing is written
# out first because `tar | grep -q` closes the pipe early and, under pipefail,
# reports failure on a successful match.
tar tzf "$OUT/$ARCHIVE_NAME" > "$OUT/members.txt"
grep -Fq 'node_modules/node-pty/prebuilds/linux-x64/pty.node' "$OUT/members.txt" \
  || die "archive is missing node_modules/node-pty/prebuilds/linux-x64/pty.node"
grep -Fq 'apps/server/dist/client/' "$OUT/members.txt" \
  || die "archive is missing the built web client (apps/server/dist/client/)"
node --check apps/server/dist/bin.mjs || die "bin.mjs failed a syntax check"

printf 'built %s\n  digest %s\n  size   %s bytes\n' \
  "$ARCHIVE_NAME" "$DIGEST" "$(stat -c%s "$OUT/$ARCHIVE_NAME")"

if [ "$ARCHIVE_ONLY" = 1 ]; then
  cp -a "$OUT/$ARCHIVE_NAME" "./$ARCHIVE_NAME"
  printf '%s\n' "$DIGEST" > "./$ARCHIVE_NAME.sha256"
  printf 'wrote ./%s (+ .sha256), not deployed\n' "$ARCHIVE_NAME"
  exit 0
fi

[ -d "$WIN_RESOURCES" ] || die "Windows resources dir not found: $WIN_RESOURCES"

mkdir -p "$BACKUP_DIR"
if [ ! -f "$BACKUP_DIR/$ARCHIVE_NAME" ]; then
  cp -a "$WIN_RESOURCES/$ARCHIVE_NAME" "$BACKUP_DIR/$ARCHIVE_NAME"
  cp -a "$WIN_RESOURCES/$ARCHIVE_NAME.sha256" "$BACKUP_DIR/$ARCHIVE_NAME.sha256"
  printf 'backed up originals to %s\n' "$BACKUP_DIR"
else
  printf 'backup already exists at %s (kept)\n' "$BACKUP_DIR"
fi

cp -a "$OUT/$ARCHIVE_NAME" "$WIN_RESOURCES/$ARCHIVE_NAME"
printf '%s\n' "$DIGEST" > "$WIN_RESOURCES/$ARCHIVE_NAME.sha256"

# Verify by re-reading from the Windows mount, not from the staging copy.
DEPLOYED="$(sha256sum "$WIN_RESOURCES/$ARCHIVE_NAME" | cut -d' ' -f1)"
SIDECAR="$(tr -d '[:space:]' <"$WIN_RESOURCES/$ARCHIVE_NAME.sha256")"
[ "$DEPLOYED" = "$DIGEST" ] || die "deployed archive digest mismatch (rollback: $0 --rollback)"
[ "$SIDECAR" = "$DIGEST" ] || die "sidecar does not match archive (rollback: $0 --rollback)"

printf 'deployed and verified. Relaunch T3 Code to install runtime sha256-%s\n' "$DIGEST"
