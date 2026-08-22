#!/usr/bin/env bash
# Contract: on macOS a `docker` that is really podman must be named as such,
# not reported as an unresponsive Docker daemon (#2933).
#
# Linux already refuses podman with a clear message
# (scripts/linux-install-preflight.sh); macOS had no podman detection at all,
# so the same host got "Start Docker Desktop ..." instead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS + 1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

# shellcheck disable=SC1091
. "$ROOT/installers/macos/lib/detection.sh"

# ── a podman shim that reports itself in --version ──────────────────────────
cat > "$TMP/bin/docker" <<'STUB'
#!/bin/sh
case "$1" in
  --version) echo "podman version 6.1.0" ;;
  context)   echo "" ;;
  version)   exit 1 ;;
  *)         exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/docker"

PATH="$TMP/bin:$PATH" test_docker_desktop
if [ "${DOCKER_BACKEND:-}" = "podman" ]; then
    pass "a podman CLI reporting itself in --version is classified as podman"
else
    fail "expected DOCKER_BACKEND=podman, got '${DOCKER_BACKEND:-}'"
fi

# ── the exact banner from #2933's log: podman relabelled as "docker" ───────
# get-ods.sh prints `docker --version` verbatim, and the reporter's log reads
# "docker found: docker version 6.1.0" — lowercase, no build field, version 6.x.
cat > "$TMP/bin/docker" <<'STUB'
#!/bin/sh
case "$1" in
  --version) echo "docker version 6.1.0" ;;
  context)   echo "" ;;
  *)         exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/docker"

PATH="$TMP/bin:$PATH" test_docker_desktop
if [ "${DOCKER_BACKEND:-}" = "podman" ]; then
    pass "podman relabelled as 'docker version 6.1.0' (#2933's actual banner) is caught"
else
    fail "expected DOCKER_BACKEND=podman for the #2933 banner, got '${DOCKER_BACKEND:-}'"
fi

# ── a podman-docker wrapper script that execs podman ───────────────────────
cat > "$TMP/bin/docker" <<'STUB'
#!/bin/sh
[ -e /etc/containers/nodocker ] || echo "Emulate Docker CLI using podman." >&2
exec /usr/bin/podman "$@"
STUB
chmod +x "$TMP/bin/docker"

PATH="$TMP/bin:$PATH" test_docker_desktop
if [ "${DOCKER_BACKEND:-}" = "podman" ]; then
    pass "a podman-docker wrapper script is caught"
else
    fail "expected DOCKER_BACKEND=podman for the wrapper script, got '${DOCKER_BACKEND:-}'"
fi

# ── a podman-docker shim that only gives itself away via the symlink ────────
cat > "$TMP/bin/podman" <<'STUB'
#!/bin/sh
exit 1
STUB
chmod +x "$TMP/bin/podman"
cat > "$TMP/bin/docker" <<'STUB'
#!/bin/sh
case "$1" in
  --version) echo "Docker version 27.0.0, build abc" ;;
  *)         exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/docker"
rm -f "$TMP/bin/docker" && ln -s "$TMP/bin/podman" "$TMP/bin/docker"

PATH="$TMP/bin:$PATH" test_docker_desktop
if [ "${DOCKER_BACKEND:-}" = "podman" ]; then
    pass "a docker symlinked to podman is classified as podman"
else
    fail "expected DOCKER_BACKEND=podman via symlink, got '${DOCKER_BACKEND:-}'"
fi

# ── a real Docker CLI must NOT be mistaken for podman ───────────────────────
rm -f "$TMP/bin/docker" "$TMP/bin/podman"
cat > "$TMP/bin/docker" <<'STUB'
#!/bin/sh
case "$1" in
  --version) echo "Docker version 27.0.0, build abc" ;;
  context)   echo "desktop-linux" ;;
  version)
    if [ "$2" = "--format" ]; then echo "27.0.0"; fi
    exit 0 ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$TMP/bin/docker"

PATH="$TMP/bin:$PATH" test_docker_desktop
if [ "${DOCKER_BACKEND:-}" = "desktop" ]; then
    pass "a genuine Docker Desktop CLI is still classified as desktop"
else
    fail "expected DOCKER_BACKEND=desktop, got '${DOCKER_BACKEND:-}'"
fi

# Real Docker's banner ("Docker version X, build Y") must never trip the
# relabelled-banner heuristic, on any context, including an unknown one.
cat > "$TMP/bin/docker" <<'STUB'
#!/bin/sh
case "$1" in
  --version) echo "Docker version 28.0.1, build 068a01e" ;;
  context)   echo "some-custom-context" ;;
  version)   exit 0 ;;
  *)         exit 0 ;;
esac
STUB
chmod +x "$TMP/bin/docker"

PATH="$TMP/bin:$PATH" test_docker_desktop
if [ "${DOCKER_BACKEND:-}" = "podman" ]; then
    fail "a genuine Docker CLI on an unknown context was misread as podman"
else
    pass "a genuine Docker CLI on an unknown context is not misread as podman (=${DOCKER_BACKEND:-})"
fi

# ── the installer must act on it ────────────────────────────────────────────
MACOS_INSTALLER="$ROOT/installers/macos/install-macos.sh"
if grep -q 'DOCKER_BACKEND:-unknown}" == "podman"' "$MACOS_INSTALLER"; then
    pass "macOS installer branches on the podman backend"
else
    fail "macOS installer must handle DOCKER_BACKEND=podman explicitly"
fi

if grep -q 'Podman is not a supported ODS runtime yet' "$MACOS_INSTALLER"; then
    pass "macOS installer states the podman limitation, matching Linux preflight"
else
    fail "macOS installer must say podman is unsupported, as Linux preflight does"
fi

echo "------------------------------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
