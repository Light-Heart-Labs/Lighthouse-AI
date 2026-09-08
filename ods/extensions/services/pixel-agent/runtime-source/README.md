# Required-plugin runtime source candidate

Not installed or enabled by ODS. This is a review/build input, not a runtime
distribution, release, deployment recipe, or permission to activate Full Access.
The feature remains dependent on parent PR #3385 and owner-managed installation.

## Provenance and build boundary

- Upstream: https://github.com/openclaw/openclaw
- Exact base: `7af0cfc9c5488e03c4e2f528bdc7ac9f7778b35e` (`v2026.6.33`).
- Patch: `openclaw-2026.6.33-required-plugins.patch`, applied to source only.
- Upstream MIT license is retained in `OPENCLAW-LICENSE`. Preserve the full
  upstream `LICENSE` and `THIRD_PARTY_NOTICES.md` in source/build distributions.
- No dependency versions, lockfiles, installed compiled files, or model pins
  are changed. ODS does not yet consume this patch in its installer.

Qualification uses a new disposable directory containing that exact source:

```sh
git apply --check /absolute/path/openclaw-2026.6.33-required-plugins.patch
git apply /absolute/path/openclaw-2026.6.33-required-plugins.patch
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm build
OPENCLAW_VITEST_MAX_WORKERS=1 corepack pnpm test \
  src/plugins/required-plugins.test.ts \
  src/agents/agent-tools.required-plugins.test.ts \
  src/gateway/server-plugins.test.ts \
  src/gateway/config-reload.test.ts \
  src/gateway/server-startup-plugins.test.ts
corepack pnpm tsgo:core
corepack pnpm tsgo:core:test
```

The observed build environment is Linux, Node 22.23.1, repository-pinned pnpm
11.2.2. Dependency installation and build are explicit disposable operations;
never run them in an installed gateway or modify `node_modules` by hand.

## Opt-in launcher contract

`OPENCLAW_REQUIRED_PLUGINS` contains bounded, strict JSON, for example:

```json
{"version":1,"plugins":[{"id":"guard-plugin","hooks":["before_agent_run","before_tool_call"]}]}
```

No value preserves upstream behavior. An empty, malformed, duplicate, unknown
hook, or unsupported-version policy is rejected. The value is captured once;
plugin configuration cannot remove it. This is metadata, never credentials.
Required IDs must also be explicitly enabled in ordinary plugin configuration,
with explicit conversation-hook permission when such hooks are required. This
does not grant permissions or enable a disabled plugin automatically.

The future managed launcher must protect this policy independently of editable
plugin entries and inject it into every covered entrypoint. Clearing an environment
variable before launching a separate unmanaged process is outside this contract.
Do not represent the environment variable itself as an OS privilege boundary.

Managed gateway startup loads full runtime hooks once before its HTTP listener,
after host services and gateway context are prepared. Optional plugin failures
remain optional; service startup retains its later lifecycle. Missing/error
required plugins and absent/non-callable required typed hooks reject startup.
Reload admission stays closed on failure; generation-bound completion prevents
an older load from reopening a newer rejected transition. Required checks also
run at embedded-agent, Pi attempt/stream, and core tool-call boundaries using the
actual composed live hook registry, not individual partial registry setters.

## Runtime proof and remaining work

Candidate patch SHA-256:
`8a31c88d0fe566e14e3998b9ba742bac2dc77775aa0154bda893b2b36da9b726`.
A fresh extraction of the exact upstream archive accepted this patch, and all
ten patched source/test files matched the qualified build tree byte-for-byte.
The final patch includes a test-only braces correction; production source did
not change after the completed build and runtime checks.

Disposable Linux qualification passed the full source build, production/test
type checks, 32 required-policy tests, three actual core-tool admission tests,
and lint for all ten changed files. Gateway regression files also passed across
the repository's selected Vitest projects (440 executions, not 440 unique tests).

The existing `tests/runtime_provider_activation.integration.mjs` retains its
upstream characterization mode. Set `OPENCLAW_PACKAGE` to a disposable built
candidate and `OPENCLAW_REQUIRED_PLUGIN_TESTS=1` to exercise mandatory startup,
optional-plugin failure, retained-session overrides, rejected reload, and repaired
restart. All inference in that fixture is synthetic loopback traffic; it is not
installed ODS chat acceptance or proof of real cloud use.

Both modes passed against the built candidate. With the contract enabled,
absent, failed, or incomplete required registrations rejected startup with no
legacy inference; an optional plugin failure did not disable the valid guard.
A rejected required-plugin reload admitted no inference, and a verified restart
restored service. The reload fixture deliberately permits one request before
disabling the plugin and one after repair; these are expected admitted calls.
The no-policy mode deliberately retains upstream's unsafe legacy cases for
compatibility characterization. It does not prove managed protection without
the launcher contract. Listener polling is supplemented by source ordering;
polling alone cannot exclude a brief listener opening.

Before installation: complete early-service/channel/cron and alternative-harness
entrypoint qualification, protect launcher/source/build custody, wire the shared
native/Edge admission and activation transaction, prove exact rollback and upgrade
behavior, and obtain required target-specific activation authority. The patch
does not implement those installation/activation steps or complete Full Access.
