# Crawl4AI

Crawl4AI runs a local browser-crawling API that turns dynamic websites into clean Markdown and structured extraction results. Its optional LLM extraction path is prewired to the ODS LiteLLM gateway using the stable `ods/current` alias, so model swaps do not leave a concrete model ID behind.

## Enable and access

```bash
ods enable crawl4ai
ods start crawl4ai
```

- Playground: `http://localhost:11235/playground`
- API: `http://localhost:11235`
- Health: `http://localhost:11235/health`

The installation hook generates `CRAWL4AI_API_TOKEN` and `CRAWL4AI_SECRET_KEY` once. Existing values are never replaced.

## Crawl a page

Use the playground for an interactive request, or call the API after obtaining a token with the generated API token. See the upstream API examples for the current request schema.

## ODS model routing

The container receives:

- `LLM_PROVIDER=openai/ods/current`
- `LLM_BASE_URL=http://litellm:4000/v1`
- `OPENAI_API_KEY` from `LITELLM_MASTER_KEY`

This keeps LLM-assisted extraction on the authenticated ODS gateway. `litellm` is therefore an explicit extension dependency.

## Isolation defaults

The service runs as upstream's unprivileged `appuser`, drops every Linux capability, has a read-only root filesystem, caps process count, and uses private tmpfs mounts for Chromium and its job state. The host port remains loopback-bound unless the operator opts into ODS LAN exposure.

## Upstream

- Project: <https://github.com/unclecode/crawl4ai>
- Docker guide: <https://github.com/unclecode/crawl4ai/blob/main/deploy/docker/README.md>
