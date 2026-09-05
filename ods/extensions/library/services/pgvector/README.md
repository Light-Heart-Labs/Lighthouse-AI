# pgvector

This extension runs PostgreSQL 17 with pgvector 0.8.1, giving ODS applications one durable boundary for relational data, transactions, metadata filters, and exact or approximate vector search.

## Enable and connect

```bash
ods enable pgvector
ods start pgvector

PGPASSWORD="$PGVECTOR_PASSWORD" psql \
  --host 127.0.0.1 --port 5432 \
  --username "${PGVECTOR_USER:-ods}" --dbname "${PGVECTOR_DATABASE:-ods}"
```

The setup hook generates `PGVECTOR_PASSWORD` once. `PGVECTOR_USER` and `PGVECTOR_DATABASE` both default to `ods`.

Prometheus metrics are available on `http://localhost:9187/metrics`. The exporter shares the database network namespace, stays loopback-bound, and reports `pg_up 1` only after an authenticated database connection succeeds.

## Verify vector support

```sql
SELECT extversion FROM pg_extension WHERE extname = 'vector';
CREATE TABLE items (id bigserial PRIMARY KEY, embedding vector(3));
CREATE INDEX ON items USING hnsw (embedding vector_l2_ops);
```

`vector` is activated automatically when a new data directory is initialized. If an existing PostgreSQL data directory is restored into `data/pgvector`, run `CREATE EXTENSION IF NOT EXISTS vector;` in each database that needs it.

## Operational defaults

The database is loopback-bound, password-authenticated with SCRAM for host connections, initialized with checksums, and given a 60-second graceful shutdown window. Its root filesystem is read-only; only `data/pgvector` persists. The capability-free metrics sidecar has its own healthcheck pinned to `pg_up 1`.

Back up with `pg_dump`/`pg_dumpall` or a storage-level snapshot taken according to PostgreSQL consistency rules. Disabling the extension does not delete data.

## Upstream

- pgvector: <https://github.com/pgvector/pgvector>
- PostgreSQL image: <https://hub.docker.com/_/postgres>
