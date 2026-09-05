# FalkorDB

FalkorDB gives local agents a persistent knowledge-graph memory layer with Cypher-style graph queries and a visual Browser. It is useful for entity relationships, provenance, multi-hop retrieval, and graph-assisted RAG.

## Enable and access

```bash
ods enable falkordb
ods start falkordb
```

- Browser: `http://localhost:3000`
- Database: `127.0.0.1:6379`

In the Browser connection form, use host `127.0.0.1`, port `6379`, and `FALKORDB_PASSWORD`. The Browser runs in the same container, so that loopback address reaches the database without opening a second trust boundary.

## Query a graph

```bash
REDISCLI_AUTH="$FALKORDB_PASSWORD" redis-cli -h 127.0.0.1 -p 6379 \
  GRAPH.QUERY agents \
  "CREATE (:Agent {name:'Codex'})-[:USES]->(:Model {name:'local'})"
```

## Stable secrets and persistence

The setup hook generates three distinct values once:

- `FALKORDB_PASSWORD` protects database commands.
- `FALKORDB_AUTH_SECRET` signs Browser sessions.
- `FALKORDB_ENCRYPTION_KEY` encrypts stored Browser connection credentials.

Graph data, local CSV imports, and encrypted Browser state persist under `data/falkordb`. AOF fsync runs every second, and `noeviction` rejects writes at `FALKORDB_MAXMEMORY` instead of silently deleting graph state.

The process runs as the upstream `redis` user with every Linux capability dropped and a read-only root filesystem. Both ports remain loopback-bound unless the operator explicitly changes `BIND_ADDRESS`.

## Upstream

- Project: <https://github.com/FalkorDB/FalkorDB>
- Documentation: <https://docs.falkordb.com/>
