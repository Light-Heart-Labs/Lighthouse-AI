# Valkey

Valkey provides a Redis-compatible data plane for low-latency cache entries, streams, pub/sub, rate limits, sessions, and agent work queues. This extension enables AOF persistence so durable state survives a clean restart.

## Enable and connect

```bash
ods enable valkey
ods start valkey

VALKEYCLI_AUTH="$VALKEY_PASSWORD" valkey-cli \
  --host 127.0.0.1 --port 6379 ping
```

The setup hook generates `VALKEY_PASSWORD` once. Existing values are never replaced.

Prometheus metrics are available at `http://localhost:9121/metrics`. The sidecar shares Valkey's network namespace and becomes healthy only when the authenticated `redis_up` metric is 1.

## Durability and memory behavior

- AOF fsync runs every second, balancing durability and write throughput.
- A snapshot is also created after 1,000 changes within 60 seconds.
- `VALKEY_MAXMEMORY` defaults to `768mb` inside a 1 GiB container limit.
- `noeviction` rejects writes at the ceiling instead of silently deleting queue or session data.

The service runs as the upstream `valkey` user with every Linux capability dropped. Its root filesystem is read-only; only `data/valkey` persists.

## Upstream

- Valkey: <https://github.com/valkey-io/valkey>
- Metrics exporter: <https://github.com/oliver006/redis_exporter>
