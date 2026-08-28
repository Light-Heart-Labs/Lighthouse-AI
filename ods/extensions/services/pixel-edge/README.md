# Pixel Edge

`pixel-edge` is ODS's internal OpenAI-compatible adapter between Open WebUI and a host-installed Pixel. It exposes no host port and never receives Pixel's OpenClaw operator token.

The trust chain is deliberately split:

1. Open WebUI authenticates here with the generated, ODS-scoped `PIXEL_OPENWEBUI_KEY`.
2. This container accepts only `GET /v1/models` and `POST /v1/chat/completions`, fixes the model to `pixel/default`, strips browser credentials and every `x-openclaw-*` header, and connects to a mounted Unix socket.
3. The host `pixel-agent` integration owns that socket and is the only component that reads and injects Pixel's full gateway credential.

Pixel is a single-owner agent runtime. The default route is therefore intended for the ODS owner surface, not an untrusted multi-user Open WebUI deployment. Hermes and OpenCode remain available as explicit rollback paths.

The socket directory is mounted read-only and has no TCP publication. `PIXEL_INGRESS_GID` grants the non-root container process access to the socket without making it world-readable.

Chat requests keep bounded 33-minute total and no-first-byte budgets. This is
one minute longer than the private host ingress and three minutes longer than
OpenClaw's ODS-managed provider timeout, allowing CPU-only first-turn prefill
without making any intermediate proxy the first timeout authority.

Run the focused offline tests from this directory:

```bash
python3 -m unittest discover -s tests -v
```
