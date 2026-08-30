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
                         exact-digest ODS plugin, three read-only tools
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

### Cancellation and sandbox execution

The Dashboard cancel path is an execution boundary, not only a UI gesture.
The ODS plugin maps the opaque chat user to one exact active OpenClaw run. Each
`exec` command in that run is launched in its own process group by an
owner-installed wrapper. Cancellation atomically creates one zero-byte marker
named with the run ID's SHA-256; the sandbox sees the owner-private control
directory read-only, terminates only that process group with `TERM` and then
`KILL`, and returns status 130. The gateway run is drained independently, the
marker is removed after a short bounded delay, and the edge closes a successful
cancelled stream with only `[DONE]`. A different concurrent chat and its
process group are not touched.

OpenClaw requires `dangerouslyAllowExternalBindSources=true` for this one
host-to-sandbox bind. ODS does not treat that opt-in as general bind authority:
the installer accepts exactly
`~/.openclaw/.ods-exec-control:/run/pixel-ods-control:ro`, validates the source
owner, type, link count, and exact `0700`/`0500` modes, recreates the Pixel
sandbox after lifecycle changes, and rejects every additional bind. OpenClaw's
security audit will still report the generic dangerous-flag warning. Removing
the flag without removing the bind makes cancellation fail closed; adding a
second source is outside the ODS contract.

The dashboard route also handles explicit requests to open private HTTP(S)
URLs at the edge. It returns one exact local explanation without forwarding the
request to Pixel or the model, while ordinary conversation, public URLs, and
text that merely mentions a private development URL continue through normally.
Private browsing requires a separately reviewed and approved capability; the
public-web tools and shell cannot be used as substitutes.

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
must not be group- or world-writable. Remote Git credential prompts are
disabled and source operations are bounded, so an inaccessible private source
fails instead of hanging the installer. Authorized users without configured
non-interactive Git access should use the local-checkout form above.

## User experience

After a successful install:

1. Open `http://localhost:3000`. New Open WebUI chats default to
   `pixel/default`; the ordinary ODS model remains selectable.
2. Open `http://localhost:3001/pixel`, or choose **Pixel** in the Dashboard
   toolbar, for the dedicated streaming agent UI.
3. Hermes remains at its authenticated proxy URL shown by the installer.
4. OpenCode remains an independent coding UI when enabled.

Open WebUI search-query generation uses the ordinary local model, not Pixel,
to avoid recursive agent routing. Automatic title, tag, and follow-up
generation is disabled while Pixel is active because those cosmetic jobs would
otherwise compete with the agent for the same local inference slot.
The dedicated Dashboard keeps the current bounded conversation and opaque chat
ID in that browser's local storage so a reload or Dashboard restart resumes the
same Pixel session. It stores no gateway credential. **New chat** replaces that
local pointer with a fresh opaque ID; older OpenClaw session files remain under
the owner's normal Pixel lifecycle and are not exposed to the browser.
For the default no-think mode, the managed Pixel route omits OpenClaw's Qwen
thinking compatibility switch and declares reasoning inactive. The independently
pinned llama.cpp no-think setting then remains authoritative on every model
request. This avoids an OpenClaw 2026.6.33 compatibility path that treats the
literal effort `off` as truthy and can otherwise spend the whole output budget
in hidden reasoning after a tool call. This policy does not broaden the tool
allowlist or make custom tools replay-safe.

### Model swapping

Pixel follows the same local-model activation transaction as the rest of ODS.
Using the Dashboard Models page or `ods model swap <tier>` updates Pixel's exact
model ID, context window, output limit, reasoning capability, and model-family
compatibility policy after the new runtime and downstream routes pass their
proofs. The gateway is restarted and verified before the transaction commits.
The public Open WebUI identity remains `pixel/default`; the underlying model is
the newly activated ODS model.

If Pixel reconciliation fails, ODS restores and proves both the previous model
runtime and Pixel route. A stopped or unmanaged Pixel is never adopted. Model
family changes are supported: an explicitly reasoning-enabled Qwen route gets
the Qwen chat-template compatibility policy and a real non-off effort; that
policy is removed for no-think Qwen routes and when a non-Qwen model is
activated. Pixel's
managed agent and tool prompt requires a context of at least 16384 tokens; all
bundled ODS catalog models are at or above that floor. An advanced custom
activation below it is rejected before any model state changes. At 16K and 24K,
ODS lowers Pixel's output ceiling to one eighth of the context; at 32K and
above it allows up to 4096 output tokens. The same value is applied as
OpenClaw's compaction reserve, with its larger embedded reserve floor disabled,
so a smaller qualified context still leaves room for Pixel's fixed prompt and
tool results.

## Bounded ODS tools

The default ODS integration exposes three read-only tools to Pixel:

- `pixel_ods_status` returns the sanitized overall ODS state, an explicit
  application count, and allowlisted application states.
- `pixel_ods_apps_list` returns the same explicit count and allowlisted
  application inventory in an app-oriented shape. The count avoids asking
  small local models to infer it from the array.
- `pixel_ods_web_extract` uses OpenClaw's strict public-web network guard to find a
  distinctive literal method or section name anywhere in a long public page.
  A bounded fallback accepts two or three keywords only when they co-occur in
  one evidence window. The tool returns only that bounded, explicitly untrusted
  window. It is the targeted fallback when the normal `web_fetch` prefix is
  truncated before the requested detail; local, private, single-label,
  credentialed, and raw-IP destinations remain blocked.

The status tools read only `/run/ods-pixel/ods-status.json`. The plugin does not
receive the Docker socket, Dashboard API key, Open WebUI key, host shell, or ODS
operator credentials. The targeted extractor receives only a public URL and
literal query and delegates transport to OpenClaw's DNS-pinned, redirect-aware
web guard. The projection accepts only its documented schema, service and app
enums, owner, mode, size, timestamp freshness, UTF-8, and fixed path. It rejects
symlinks, replacement races, unknown keys, duplicate apps, stale or future
timestamps, and group/world-writable files.

Adding an ODS action is a security-boundary change. It requires a new explicit
tool contract, policy and authorization design, adversarial tests, and fresh
install/rollback qualification; do not broaden the projection reader into a
generic shell, HTTP, Docker, or filesystem tool.

OpenClaw's security audit also reports its generic `models.small_params`
critical when the active local model is at or below 300B and public web tools
are enabled. The qualified ODS posture is a personal assistant for one trusted
operator, with sandbox mode `all`, bounded tool loops, public-only destinations,
and page content explicitly treated as untrusted evidence. It is not a
multi-tenant or hostile-input deployment. Operators who expose Pixel to
untrusted users must deny `group:web` and `browser` for that model (losing web
research) or qualify a stronger model and threat model first; do not describe
the generic audit finding as green or suppressed.

## Installer ownership and upgrades

ODS writes `~/.config/ods/pixel-managed.json` with mode `0600`. The marker is
created before Pixel is changed and moves from `installing` to `ready` only
after Pixel verification, systemd activation, and private-ingress health pass.
The marker records that no active Pixel release or runtime attestation existed
before ODS created it. After Pixel verification it binds the verified contract,
live config, exact active release identity and install-manifest hashes, release
version, and validated live sandbox image ID while remaining `installing`, so
an interrupted ingress setup can safely verify and reuse the active release on
retry without claiming readiness. The ready marker also binds the exact Pixel
source revision and a domain-separated SHA-256 of the deterministic ODS
onboarding contract, including the approved ODS plugin tree digest, plus a
canonical hash of the verified live OpenClaw configuration. When all bindings
match exactly, a rerun skips Pixel's
same-release apply transaction, verifies the exact source, and reinstalls the
ODS ingress. If only the ODS extension contract changed while the exact
verified Pixel source and newly planned canonical runtime configuration still
match the live configuration, ODS refreshes OpenClaw's persisted plugin
registry, verifies the exact plugin root and three-tool descriptor in both the
persisted and current registry views, then restarts and verifies the gateway.
Pixel source drift or runtime-configuration drift takes the ordinary
configure/plan/apply path and remains fail closed.

The managed runtime preserves Pixel's upstream workspace-bootstrap ceilings
(`bootstrapMaxChars=32000` and `bootstrapTotalMaxChars=96000`). These are
ceilings, not forced prompt sizes. They prevent the shipped `AGENTS.md` and
`TOOLS.md` operating contracts from being silently truncated while still
letting OpenClaw inject only the files that are present. A gateway warning that
either file was truncated is a qualification failure for the default ODS
workspace.

ODS will not adopt or overwrite an ambient Pixel/OpenClaw deployment. If it
finds an existing OpenClaw configuration, Pixel gateway environment, Pixel
onboarding record, active release, runtime attestation, or gateway systemd unit
without its management marker, the installer stops and leaves that deployment
untouched.

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
Compose layer, model registration, environment, and default route. When the
private ODS management marker securely binds the active deployment to this
exact install, rollback also stops and removes the managed host gateway and
private ingress, removes their active release link and runtime attestation, and
moves the fully verified release tree into Pixel's private
`retired-ods-releases/` archive. An ambient, legacy, incompletely bound, or
drifted Pixel/OpenClaw deployment is left untouched. Re-enable only after the
qualification predicate and written authorization are still valid; ODS then
recreates the live deployment from the configured immutable Pixel source:

```bash
PIXEL_LICENSE_ACCEPTED=true ./install.sh --pixel
```

A full `ods-uninstall.sh` removes the Pixel host deployment only when the
private ODS management marker securely binds it to that exact install. It
stops the ingress before the gateway, validates every user and root deletion
target before mutation, and leaves an ambient, legacy, incompletely bound, or
drifted Pixel/OpenClaw deployment untouched. For a fully bound ODS-created
deployment, uninstall holds Pixel's deployment lock, verifies the installed
release manifest, retires only Pixel's validated sandbox containers, and
removes the exact live sandbox tag, active-release link, and runtime
attestation. It moves the byte-verified release tree out of Pixel's active
`releases/<version>` namespace into a private
`retired-ods-releases/<version>-<identity>.<nonce>/release` archive. The exact
retired bytes, candidate image tag, deployment lock, browser/bootstrap caches,
workspace, and user backups therefore remain available for recovery without a
path-bound release blocking a fresh install of the same Pixel version. An
interrupted deactivation resumes from its private staged or archive state. This
behavior is the same with `--keep-data`; that flag additionally preserves the
ODS `data/` tree. The bounded deactivation prevents a retired ODS install from
blocking a later fresh install at a different path without treating ambient
Pixel state as ODS-owned.

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
- a fresh first turn with no workspace-bootstrap truncation warning and a
  visible `Working` state while a tool turn is active;
- cancellation of a real long-running sandbox command, proving a clean
  `[DONE]` stream, status 130, marker cleanup, no surviving descendant, and a
  successful fresh command afterward;
- concurrent-chat cancellation isolation, proving the cancelled command stops
  while the other chat completes unchanged;
- a real turn invoking `pixel_ods_status` with sanitized ODS results;
- a cross-family model swap and a context-only change, with Pixel using the
  newly active identity and invoking both bounded ODS tools after each change;
- rejection of a managed-Pixel activation below 16K with the previous runtime,
  persisted configuration, and gateway process unchanged;
- `--no-pixel --hermes` rollback with ordinary chat and Hermes verified;
- reinstallation/reactivation from the same clean, exact source; and
- OpenClaw's deep security audit, with every remaining finding recorded and
  reconciled to this documented single-operator threat model.

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
