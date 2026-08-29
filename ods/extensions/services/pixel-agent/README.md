# Pixel Agent (host ingress)

Dependency-free host ingress that exposes a single **Pixel** gateway to Open
WebUI over a restricted Unix-domain socket. It implements only the host side
of the integration: it owns no container, binds no TCP port, and exists purely
as a hard boundary between Open WebUI and the operator's Pixel gateway.

## Trust model

**Pixel is a single-owner, operator-trusted agent.** This service is the
intentional choke point that decides exactly what reaches the Pixel gateway:

- The gateway token is read **only** from `PIXEL_GATEWAY_TOKEN_FILE` (default
  `/etc/pixel/openclaw.json`), a file that must be owned by the process euid,
  be a regular file (never a symlink), and not be group/world-readable. The
  token is never logged, never written to the status projection, and never
  echoed to any caller.
- **Open WebUI never receives the operator token.** Callers authenticate to
  the socket via the Unix-socket group boundary (`PIXEL_INGRESS_GID`), not via
  a bearer token. The gateway token stays inside the host ingress process.
- No inbound headers are ever forwarded. Inbound `Authorization`, `Cookie`,
  `Forwarded`, `X-Forwarded-*`, and `x-openclaw-*` headers are dropped. The
  upstream request carries only a freshly constructed allowlisted set.

## Surface

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/health` | Unauthenticated liveness |
| `POST` | `/v1/chat/completions` | Sanitized, allowlisted forward to the gateway |

Only these two routes exist; everything else returns `404`/`405`. The server
listens **only** on `PIXEL_INGRESS_SOCKET` (default
`/run/ods-pixel/pixel-ingress.sock`) and never listens on TCP.

## Security boundaries

- **Unix-domain socket only.** The socket is created at the fixed service path,
  mode `0660`, best-effort `chgrp` to `PIXEL_INGRESS_GID`. If a non-socket path
  already exists at the socket location, the service refuses to start. It only
  ever removes an existing *socket* at its own path.
- **Request hardening.** Request bodies are capped at 2 MiB. Only these fields
  are forwarded (when type-valid): `messages`, `stream`, `temperature`,
  `top_p`, `max_tokens`, `stop`, `tools`, `tool_choice`, `response_format`.
  `model` is forced to `openclaw/default`. Unknown fields are dropped. Invalid
  bodies are rejected with a generic sanitized JSON error.
- **Stable hashed session.** When a caller supplies a string `user`,
  `metadata.chat_id`, or `metadata.conversation_id`, the ingress writes
  `user = "ods-" + sha256(chosen)`. The raw identifier is never passed
  upstream.
- **Upstream is fixed.** Requests go only to
  `http://127.0.0.1:${PIXEL_GATEWAY_PORT:-18789}/v1/chat/completions` with
  `Authorization: Bearer <gateway token>`, `Content-Type: application/json`,
  and `Accept` matching the stream mode. Connect/header/body/stream behavior is
  bounded by `AbortController`/timeouts; the total request budget is 32 minutes
  so CPU-only first-turn prefill can finish inside OpenClaw's 30-minute model
  budget and 31-minute stalled-session recovery budget. The fixed loopback hop
  uses Node's core HTTP client instead of the built-in `fetch`, avoiding
  Undici's implicit five-minute response-body idle cutoff; only the explicit
  connect and total budgets can end the request. The non-stream response is
  capped at 2 MiB and each stream line at 1 MiB.
  Upstream bodies are never reflected to the caller; failures produce generic
  errors.
- **Status projection.** On startup and every `PIXEL_STATUS_INTERVAL_MS`
  (default 30000) the service atomically writes a sanitized projection to
  `PIXEL_STATUS_FILE` (default `/run/ods-pixel/ods-status.json`). It reports a
  timestamp, Pixel gateway reachability, ingress readiness, and a **fixed
  allowlist** of ODS service names/statuses obtained by running exactly
  `docker ps --format {{json .}}` via `execFile` with an explicit timeout.
  Container names outside the allowlist, raw command output, environment,
  secrets, image labels, IDs, and mounts are never surfaced. The same fixed,
  argument-only Docker boundary reports the configured llama-server model
  basename and context length. The projection also carries the nonsecret ODS
  version installed by ODS and exact normalized online/deployed-application
  counts; stopped allowlisted containers remain in the deployed total.
  If Docker is unavailable, it carries an empty `apps` array, a null runtime,
  and a generic `unavailable` state.
- **Visible post-tool replies.** The plugin adds a Pixel-only system prompt
  contract requiring a visible final response after either projection tool.
  The status remains untrusted evidence and never becomes action authority.

## Configuration (nonsecret)

| Variable | Default | Description |
|----------|---------|-------------|
| `PIXEL_INGRESS_SOCKET` | `/run/ods-pixel/pixel-ingress.sock` | Unix socket path (UDS only) |
| `PIXEL_INGRESS_GID` | unset | Numeric GID allowed to connect to the socket |
| `PIXEL_GATEWAY_TOKEN_FILE` | `/etc/pixel/openclaw.json` | Restricted owner-private OpenClaw config containing the gateway token |
| `PIXEL_GATEWAY_PORT` | `18789` | Fixed loopback gateway port |
| `PIXEL_STATUS_FILE` | `/run/ods-pixel/ods-status.json` | Status projection path |
| `PIXEL_STATUS_INTERVAL_MS` | `30000` | Status write interval |
| `PIXEL_ODS_VERSION` | `unknown` | Nonsecret ODS version exposed in the bounded status projection |

Secrets are never configured here. The token lives only in
`PIXEL_GATEWAY_TOKEN_FILE`.

## systemd unit

`host/pixel-ingress.service` runs as the same unprivileged owner as the Pixel
gateway and is hardened with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=true`,
`PrivateTmp`, `PrivateDevices`, `RestrictAddressFamilies=AF_UNIX AF_INET
AF_INET6`, an explicit read-only bind for the gateway token file, and a `UMask=0007`.
It creates `/run/ods-pixel` (`RuntimeDirectory` mode `0710`) and restarts on
failure. It contains no credential.

## Rollback

This ingress is an additive host service. Removing it restores the previous
state: Open WebUI simply cannot reach the Pixel gateway, and the default agent
surface falls back to the ODS-managed agent lanes (**Hermes**, or **OpenCode**
for coding). There is no container, no port, and no persistent state to tear
down beyond the runtime socket and status file in `/run/ods-pixel`.

## Development

The implementation is importable and does **not** start a server when imported;
it only starts when run as the main module. Run the test suite with:

```bash
node --test ods/extensions/services/pixel-agent/tests/*.test.mjs
```

Requires Node 20+ and uses built-ins only (no npm dependencies).
