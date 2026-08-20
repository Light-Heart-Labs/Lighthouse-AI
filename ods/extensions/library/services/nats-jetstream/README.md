# NATS JetStream

NATS gives local services a lightweight event backbone for pub/sub and request/reply. JetStream adds durable streams, replay, retention, and pull or push consumers for agent jobs that must survive restarts.

## Enable and connect

```bash
ods enable nats-jetstream
ods start nats-jetstream

export NATS_URL=nats://127.0.0.1:4222
export NATS_USER="${NATS_USER:-ods}"
export NATS_PASSWORD
nats server check connection
```

The setup hook generates `NATS_PASSWORD` and a distinct `NATS_JETSTREAM_KEY` once. Both start with `nats_` because the NATS config parser can interpret digit-leading environment values as numbers. Custom values must likewise begin with a letter. Existing values are never replaced.

## Create a durable event stream

```bash
nats stream add ODS_EVENTS \
  --subjects 'ods.events.>' --storage file --retention limits --defaults
nats publish ods.events.agent.started '{"agent":"researcher"}'
nats stream info ODS_EVENTS
```

## Durability and observability

JetStream files persist under `data/nats-jetstream` and are encrypted with ChaCha using `NATS_JETSTREAM_KEY`. Preserve that key with backups: encrypted streams cannot be recovered without it. Memory and file stores are capped at 256 MB and 10 GB by default.

- Readiness: `http://localhost:8222/healthz?js-enabled-only=true`
- JetStream diagnostics: `http://localhost:8222/jsz`

The monitoring port is unauthenticated by NATS and is therefore loopback-bound by default. Client connections require credentials. The server runs as UID 1000 with every Linux capability dropped and a read-only root filesystem.

## Upstream

- Server: <https://github.com/nats-io/nats-server>
- JetStream documentation: <https://docs.nats.io/nats-concepts/jetstream>
