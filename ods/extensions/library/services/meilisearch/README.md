# Meilisearch

Meilisearch is a low-latency search API with typo tolerance, filtering, faceting, and hybrid-search primitives. This extension provides a reusable ODS search service; it is separate from the private Meilisearch sidecar bundled inside LibreChat.

## Enable and access

```bash
ods enable meilisearch
ods start meilisearch
```

- API: `http://localhost:7700`
- Health: `http://localhost:7700/health`

The setup hook generates `MEILI_MASTER_KEY` once. Existing values are never replaced.

## Index documents

```bash
curl -X POST http://localhost:7700/indexes/notes/documents \
  -H "Authorization: Bearer $MEILI_MASTER_KEY" \
  -H "Content-Type: application/json" \
  --data '[{"id":1,"title":"Local AI","body":"Private search on ODS"}]'

curl 'http://localhost:7700/indexes/notes/search?q=private' \
  -H "Authorization: Bearer $MEILI_MASTER_KEY"
```

## Isolation defaults

The API is master-key protected, loopback-bound by default, has analytics disabled, drops every Linux capability, and runs with a read-only root filesystem. Only `data/meilisearch` persists indexes; `/tmp` is ephemeral.

## Upstream

- Project: <https://github.com/meilisearch/meilisearch>
- Documentation: <https://www.meilisearch.com/docs>
