# Pixel in ODS

Pixel is ODS's preferred conversational agent on the narrow host and license
path described here. It is exposed as the default `pixel/default` model in
Open WebUI and as a dedicated **Pixel** app in the ODS Dashboard toolbar.
Hermes remains installed by default as the portable fallback and rollback
agent. Deprecated OpenClaw and the OpenCode coding UI remain separately
selectable; this integration does not delete either one.

## Legal and release boundary

Pixel's repository currently uses a proprietary, all-rights-reserved license.
ODS does not grant a right to install or use Pixel. Set
`PIXEL_LICENSE_ACCEPTED=true` only after a separately negotiated written
agreement authorizes the relevant installation. A public ODS release cannot
legally deliver Pixel to every installer until the Pixel copyright holder
publishes a compatible license or grants the required distribution and use
rights.

This technical integration therefore fails closed:

| Request | Qualified host | Written authorization acknowledged | Result |
|---------|----------------|------------------------------------|--------|
| `ENABLE_PIXEL=auto` (default) | Yes | Yes | Pixel is the default agent |
| `ENABLE_PIXEL=auto` | No | Any | Hermes fallback; ODS installation continues |
| `ENABLE_PIXEL=auto` | Yes | No | Hermes fallback; ODS installation continues |
| `--pixel` | Yes | Yes | Pixel is required and installed |
| `--pixel` | No | Any | Installer stops before changing the agent route |
| `--pixel` | Yes | No | Installer stops before changing the agent route |
| `--no-pixel` | Any | Any | Pixel route is disabled; Hermes remains available |

The environment value must be exactly `true`. There is no click-through or
implicit acceptance.

## Host eligibility

Pixel is selected only on:

- Ubuntu 24.04 LTS or Debian 12;
- Linux with `systemd` as PID 1;
- a native Linux host or WSL2 (WSL1 is rejected); and
- the bundled local ODS model route in this first integration slice.

ODS supports more platforms than Pixel. macOS, Windows-native, other Linux
distributions, cloud mode, external Ollama/LM Studio, and external Lemonade
continue to install ODS and use Hermes. These are ODS capability gates, not a
reduction of the ODS support matrix.

## Architecture

```text
Browser
  | no Pixel credential
  +--> Open WebUI ------------------------------+
  |                                             |
  +--> Dashboard /pixel -> nginx -> dashboard-api
                                                |
                         narrow generated edge key
                                                v
                                  pixel-edge container
                                  - no published port
                                  - read-only filesystem
                                  - fixed pixel/default model
                                                |
                                  mode-0660 Unix socket
                                                v
                                  pixel-ingress.service
                                  - unprivileged Pixel owner
                                  - no listening TCP port
                                  - request allowlist and bounds
                                                |
                          owner-private gateway token injected here only
                                                v
                           Pixel/OpenClaw gateway on 127.0.0.1:18789
                                                |
                         exact-digest ODS plugin, two read-only tools
                                                v
                         /run/ods-pixel/ods-status.json (mode 0640)
```

The Open WebUI and Dashboard paths converge at `pixel-edge`. The browser never
receives either the edge key or Pixel's operator/gateway token. The edge key
cannot call the loopback gateway directly. With the rest of the owner's home
hidden, the host ingress bind-mounts only Pixel's exact owner-private gateway
config read-only into its private runtime namespace, injects its token only on
the final loopback hop, strips inbound headers, forces `openclaw/default`, and
bounds request, response, stream, and timeout sizes.

The edge and host ingress health checks fail closed unless the next hop is
actually ready. Open WebUI is not allowed to advertise `pixel/default` while
the private ingress is unavailable.

## Install

From an authorized Ubuntu 24.04 or Debian 12 host:

```bash
git clone https://github.com/Osmantic/ODS.git
cd ODS/ods
PIXEL_LICENSE_ACCEPTED=true ./install.sh --pixel
```

Omit `--pixel` to use automatic selection. Explicit `--pixel` is recommended
for qualification because it turns an unexpected fallback into a visible
installer failure.

The installer pins Pixel to an immutable full commit. To qualify an
owner-controlled local Pixel checkout, place it under a secure directory you
own and set all three source values:

```bash
PIXEL_LICENSE_ACCEPTED=true \
PIXEL_SOURCE_DIR=/home/me/src \
PIXEL_SOURCE_URL=/home/me/src/Pixel \
PIXEL_SOURCE_REF=<40-character-commit> \
./install.sh --pixel
```

The canonical remote URL is the only remote source accepted. A local source
must be a clean Git checkout below `PIXEL_SOURCE_DIR`; the owner directories
must not be group- or world-writable.

## User experience

After a successful install:

1. Open `http://localhost:3000`. New Open WebUI chats default to
   `pixel/default`; the ordinary ODS model remains selectable.
2. Open `http://localhost:3001/pixel`, or choose **Pixel** in the Dashboard
   toolbar, for the dedicated streaming agent UI.
3. Hermes remains at its authenticated proxy URL shown by the installer.
4. OpenCode remains an independent coding UI when enabled.

Open WebUI background/title tasks use the ordinary local model, not Pixel, to
avoid recursively creating agent turns.

## Bounded ODS tools

The first slice exposes exactly two read-only tools to Pixel:

- `pixel_ods_status` returns the sanitized overall ODS state, an explicit
  application count, and allowlisted application states.
- `pixel_ods_apps_list` returns the same explicit count and allowlisted
  application inventory in an app-oriented shape. The count avoids asking
  small local models to infer it from the array.

The plugin reads only `/run/ods-pixel/ods-status.json`. It does not receive the
Docker socket, Dashboard API key, Open WebUI key, host shell, or ODS operator
credentials. The projection accepts only its documented schema, service and
app enums, owner, mode, size, timestamp freshness, UTF-8, and fixed path. It
rejects symlinks, replacement races, unknown keys, duplicate apps, stale or
future timestamps, and group/world-writable files.

Adding an ODS action is a security-boundary change. It requires a new explicit
tool contract, policy and authorization design, adversarial tests, and fresh
install/rollback qualification; do not broaden the projection reader into a
generic shell, HTTP, Docker, or filesystem tool.

## Installer ownership and upgrades

ODS writes `~/.config/ods/pixel-managed.json` with mode `0600`. The marker is
created before Pixel is changed and moves from `installing` to `ready` only
after Pixel verification, systemd activation, and private-ingress health pass.
After Pixel verification it binds the verified contract and live config while
remaining `installing`, so an interrupted ingress setup can safely verify and
reuse the active release on retry without claiming readiness.
The ready marker binds the exact Pixel source revision and a domain-separated
SHA-256 of the deterministic ODS onboarding contract, including the approved
ODS plugin tree digest, plus a canonical hash of the verified live OpenClaw
configuration. When all bindings match exactly, a rerun skips Pixel's
same-release apply transaction, verifies the exact source, and reinstalls the
ODS ingress. If only the ODS extension contract changed while the exact
verified Pixel source and newly planned canonical runtime configuration still
match the live configuration, ODS restarts and verifies the gateway before
refreshing the extension. Pixel source drift or runtime-configuration drift
takes the ordinary configure/plan/apply path and remains fail closed.

ODS will not adopt or overwrite an ambient Pixel/OpenClaw deployment. If it
finds an existing OpenClaw configuration, Pixel gateway environment, Pixel
onboarding record, or gateway systemd unit without its management marker, the
installer stops and leaves that deployment untouched.

## Configuration reference

| Variable | Default / owner | Meaning |
|----------|-----------------|---------|
| `ENABLE_PIXEL` | `auto` | `auto`, exact `true`, or exact `false` selection |
| `PIXEL_LICENSE_ACCEPTED` | unset/false; operator | Exact acknowledgement after written authorization |
| `PIXEL_SOURCE_URL` | canonical Pixel GitHub URL | Canonical remote or validated local checkout |
| `PIXEL_SOURCE_REF` | ODS-pinned full SHA | Immutable Pixel source revision |
| `PIXEL_SOURCE_DIR` | empty | Secure owner-controlled root for a local checkout |
| `PIXEL_OPENWEBUI_KEY` | generated; installer | Narrow Open WebUI/Dashboard-to-edge key; secret |
| `PIXEL_INGRESS_RUNTIME_DIR` | `/run/ods-pixel` | Host directory containing only the socket/projection |
| `PIXEL_INGRESS_GID` | generated; installer | Numeric `ods-pixel` group used by the edge container |

Do not copy generated secrets into issues, logs, support bundles, or PRs.

## Health and operations

```bash
systemctl status openclaw-gateway.service pixel-ingress.service
sudo -u "$USER" curl --unix-socket /run/ods-pixel/pixel-ingress.sock \
  http://localhost/health
docker inspect --format '{{.State.Health.Status}}' ods-pixel-edge
docker compose ps
```

Expected state is two active system services, `{"status":"ok"}` from the
private socket, and a healthy `ods-pixel-edge`. The socket is intentionally not
reachable over a host TCP port.

Useful logs:

```bash
journalctl -u openclaw-gateway.service -u pixel-ingress.service --since today
docker logs ods-pixel-edge
docker logs ods-dashboard-api
```

Errors are sanitized across both proxies. Inspect service logs for diagnosis;
the UI intentionally does not reflect gateway bodies, tokens, filesystem
paths, or internal exception text.

## Rollback

To restore Hermes as the default agent route:

```bash
./install.sh --no-pixel --hermes
```

Then verify Open WebUI selects the ordinary ODS model, the Dashboard remains
healthy, and the authenticated Hermes URL works. This removes the Pixel edge
Compose layer, model registration, environment, and default route. The
ODS-managed host gateway and private ingress may remain running as a warm,
unexposed re-enable path; rollback does not delete the managed deployment.
Re-enable only after the qualification predicate and written authorization are
still valid:

```bash
PIXEL_LICENSE_ACCEPTED=true ./install.sh --pixel
```

A full `ods-uninstall.sh` removes the Pixel host deployment only when the
private ODS management marker securely binds it to that exact install. It
stops the ingress before the gateway, validates every user and root deletion
target before mutation, and leaves an ambient or drifted Pixel/OpenClaw
deployment untouched. This cleanup prevents a retired ODS install from
blocking a later fresh install at a different path.

## Qualification gate

A candidate is not fresh-install ready until all of these pass on the exact PR
head:

- Pixel host ingress and projection Node tests;
- Pixel edge proxy Python tests;
- capability, license, immutable-source, and host-installer Bash tests;
- resolved Docker Compose validation with no published Pixel port or operator
  token and a real health dependency from Open WebUI;
- Dashboard API tests, Dashboard component tests, and production build;
- extension manifest validation and repository regression checks;
- a clean supported-host install with PID1 systemd;
- a real Open WebUI `pixel/default` chat;
- a real Dashboard `/pixel` streaming chat;
- a real turn invoking `pixel_ods_status` with sanitized ODS results;
- `--no-pixel --hermes` rollback with ordinary chat and Hermes verified; and
- reinstallation/reactivation from the same clean, exact source.

Record the ODS and Pixel commit SHAs, resolved Compose config, service states,
test logs, install log, and sanitized chat/tool evidence. A green unit suite
alone is not proof of live usability.

## Maintainer change map

| Concern | Source of truth |
|---------|-----------------|
| Host/license/source capability gates | `installers/lib/pixel-integration.sh` |
| Host installation, adoption guard, systemd | `installers/lib/pixel-host-install.sh` |
| Open WebUI and Dashboard edge | `extensions/services/pixel-edge/` |
| Host ingress and bounded ODS plugin | `extensions/services/pixel-agent/` |
| Dashboard API/UI | `extensions/services/dashboard-api/routers/pixel.py`, `extensions/services/dashboard/src/pages/Pixel.jsx` |
| Feature selection and Compose inclusion | `installers/phases/03-features.sh`, `installers/phases/11-services.sh` |
| Generated secrets and pinned source | `installers/phases/06-directories.sh` |
| Health and operator handoff | `installers/phases/12-health.sh`, `installers/phases/13-summary.sh` |
| Focused integration tests | `tests/test-pixel-*.sh` and each service's `tests/` directory |
