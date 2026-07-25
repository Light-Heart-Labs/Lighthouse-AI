#!/usr/bin/env bash
# Test lib/qrcode.sh: _ods_lan_ip must read the source address by label.
#
# `ip route get` only prints `via <gateway>` when the destination is reached
# through a router. A directly-connected destination omits those two fields,
# so every later field shifts left and a fixed-position read lands on the
# wrong token. The success card and the install QR code are built from this
# value, so a wrong read ships the user a URL they cannot open.
#
# Run from repo root:  bash ods/tests/test-lan-ip-detection.sh
# Or from ods:         bash tests/test-lan-ip-detection.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() { echo "[FAIL] $*"; exit 1; }
pass() { echo "[PASS] $*"; }

[[ -f "$ROOT_DIR/lib/qrcode.sh" ]] || fail "lib/qrcode.sh not found"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

# Stub `ip` and hide `ifconfig` so only the `ip route get` branch is exercised.
mkdir -p "$tmpdir/bin"
cat > "$tmpdir/bin/ip" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' "$ODS_TEST_IP_ROUTE_OUTPUT"
EOF
chmod +x "$tmpdir/bin/ip"
# Silence the ifconfig fallback so a real host address can never leak into
# the cases that assert an empty result.
printf '#!/usr/bin/env bash\nexit 0\n' > "$tmpdir/bin/ifconfig"
chmod +x "$tmpdir/bin/ifconfig"

run_lan_ip() {
    ODS_TEST_IP_ROUTE_OUTPUT="$1" PATH="$tmpdir/bin:$PATH" bash -c '
        . "'"$ROOT_DIR"'/lib/qrcode.sh"
        _ods_lan_ip
    '
}

echo "Test 1: route through a gateway reports the source address"
got="$(run_lan_ip '1.1.1.1 via 192.168.1.1 dev eth0 src 192.168.1.42 uid 1000')"
[[ "$got" == "192.168.1.42" ]] || fail "gateway route: expected 192.168.1.42, got '$got'"
pass "gateway route resolves the source address"

echo "Test 2: directly-connected route reports the source address"
# No `via <gateway>`: the fields after `dev` sit two positions earlier, which
# is where a fixed-position read picks up the uid value instead of the address.
got="$(run_lan_ip '1.1.1.1 dev eth0 src 10.0.0.5 uid 1000')"
[[ "$got" == "10.0.0.5" ]] || fail "on-link route: expected 10.0.0.5, got '$got'"
pass "on-link route resolves the source address"

echo "Test 3: a route with no source address yields nothing"
got="$(run_lan_ip '1.1.1.1 via 192.168.1.1 dev eth0')"
[[ -z "$got" ]] || fail "expected empty result, got '$got'"
pass "missing source address yields empty"

echo "Test 4: non-address output never reaches the URL"
got="$(run_lan_ip 'RTNETLINK answers: Network is unreachable')"
[[ -z "$got" ]] || fail "expected empty result, got '$got'"
pass "unparseable output yields empty"

echo "Test 5: an empty LAN IP falls back to localhost in the QR URL"
url="$(ODS_TEST_IP_ROUTE_OUTPUT='' PATH="$tmpdir/bin:$PATH" bash -c '
    . "'"$ROOT_DIR"'/lib/qrcode.sh"
    print_dashboard_qr
' | grep -o 'http://[^ ]*' | head -n 1)"
[[ "$url" == "http://localhost:3001" ]] || fail "expected localhost fallback, got '$url'"
pass "empty detection falls back to localhost"

echo ""
echo "All LAN IP detection tests passed."
