# Gotenberg

Gotenberg is a local document-to-PDF API powered by Chromium, LibreOffice, and PDF tooling. It accepts multipart HTTP requests and returns the converted PDF directly.

## Enable and access

```bash
ods enable gotenberg
ods start gotenberg
```

- API: `http://localhost:3000`
- Health: `http://localhost:3000/health`
- Version: `http://localhost:3000/version`

## Convert a URL

```bash
curl -X POST http://localhost:3000/forms/chromium/convert/url \
  -F url=https://example.com \
  -o page.pdf
```

## Convert an office document

```bash
curl -X POST http://localhost:3000/forms/libreoffice/convert \
  -F files=@document.docx \
  -o document.pdf
```

Private and loopback URL targets are denied by default to keep a conversion request from probing services on the ODS network. Set `GOTENBERG_DENY_PRIVATE_IPS=false` only when conversion of trusted internal URLs is required.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `GOTENBERG_PORT` | `3000` | Host port for the conversion API |
| `GOTENBERG_DENY_PRIVATE_IPS` | `true` | Blocks private-network sources used by remote-download features |

The service is loopback-bound by default and intentionally has no dashboard launch link because it exposes an API rather than a user interface.

## Upstream

- Project: <https://github.com/gotenberg/gotenberg>
- API routes: <https://gotenberg.dev/docs/getting-started/routes>
