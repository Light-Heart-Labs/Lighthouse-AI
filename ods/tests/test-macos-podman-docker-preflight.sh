#!/usr/bin/env bash
# Contract: macOS docker detection classifies a Podman docker-CLI shim and
# tells the operator to start the Podman machine (#2933), instead of a
# generic "start Docker Desktop / Colima / …" miss.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DET="$ROOT_DIR/installers/macos/lib/detection.sh"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
PASSED=0
FAILED=0
pass() { printf "  ${GREEN}✓ PASS${NC} %s\n" "$1"; PASSED=$((PASSED + 1)); }
fail() { printf "  ${RED}✗ FAIL${NC} %s\n" "$1"; FAILED=$((FAILED + 1)); }

echo ""
echo "=== macOS Podman docker-CLI preflight (#2933) ==="
echo ""

if bash -n "$DET"; then
    pass "detection.sh passes bash -n"
else
    fail "detection.sh bash -n failed"
fi

# shellcheck source=../installers/macos/lib/detection.sh
source "$DET"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

write_stub() {
    local dest="$1"
    cat > "$dest"
    chmod +x "$dest"
}

assert_eq() {
    local label="$1" actual="$2" expected="$3"
    if [[ "$actual" == "$expected" ]]; then
        pass "$label"
    else
        fail "$label (got <$actual>, expected <$expected>)"
    fi
}

# --- Stub: Podman docker CLI, machine stopped (client --version works, engine does not)
write_stub "$TMP_DIR/docker" <<'EOF'
#!/usr/bin/env bash
case "$1" in
    --version)
        echo "podman version 5.8.1"
        exit 0
        ;;
    context)
        exit 1
        ;;
    version|info)
        echo "Cannot connect to Podman" >&2
        exit 1
        ;;
    *)
        exit 1
        ;;
esac
EOF

PATH="$TMP_DIR:$PATH"
hash -r 2>/dev/null || true
unset DOCKER_HOST
test_docker_desktop
assert_eq "Podman shim is installed" "$DOCKER_INSTALLED" "true"
assert_eq "stopped Podman machine is not running" "$DOCKER_RUNNING" "false"
assert_eq "backend is podman" "$DOCKER_BACKEND" "podman"

hint="$(macos_docker_daemon_startup_hint)"
if [[ "$hint" == *"podman machine start"* ]] && [[ "$hint" == *"Podman Desktop"* ]]; then
    pass "daemon-down hint names podman machine start"
else
    fail "daemon-down hint missing Podman guidance: <$hint>"
fi
if [[ "$hint" == *"Docker Desktop from /Applications"* ]]; then
    fail "Podman backend still used Docker Desktop-only hint"
else
    pass "Podman backend does not use Docker Desktop-only hint"
fi

# --- Stub: Docker Desktop engine up
write_stub "$TMP_DIR/docker" <<'EOF'
#!/usr/bin/env bash
case "$1" in
    --version)
        echo "Docker version 28.0.4, build b8034c0"
        exit 0
        ;;
    context)
        if [[ "${2:-}" == "show" ]]; then
            echo "desktop-linux"
            exit 0
        fi
        if [[ "${2:-}" == "inspect" ]]; then
            echo "unix:///Users/me/.docker/run/docker.sock"
            exit 0
        fi
        exit 1
        ;;
    version)
        if [[ "${2:-}" == "--format" ]]; then
            echo "28.0.4"
            exit 0
        fi
        echo "Client: Docker Engine"
        echo "Server: Docker Engine"
        exit 0
        ;;
    info)
        if [[ "${2:-}" == "--format" ]]; then
            echo "28.0.4"
            exit 0
        fi
        exit 0
        ;;
    *)
        exit 1
        ;;
esac
EOF

hash -r 2>/dev/null || true
unset DOCKER_HOST
test_docker_desktop
assert_eq "Docker Desktop is installed" "$DOCKER_INSTALLED" "true"
assert_eq "Docker Desktop daemon is running" "$DOCKER_RUNNING" "true"
assert_eq "backend is desktop" "$DOCKER_BACKEND" "desktop"

DOCKER_BACKEND=desktop
hint="$(macos_docker_daemon_startup_hint)"
if [[ "$hint" == *"Docker Desktop"* ]]; then
    pass "desktop hint still names Docker Desktop"
else
    fail "desktop hint lost Docker Desktop: <$hint>"
fi

echo ""
echo "Result: $PASSED passed, $FAILED failed"
echo ""
[[ "$FAILED" -eq 0 ]]
