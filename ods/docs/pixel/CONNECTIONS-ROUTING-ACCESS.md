# Pixel connections, provider roles and access modes

Status: development. This work is stacked on ODS PR #3385. The initial contract
modules do not activate remote inference, cloud failover or Full Access.

## Independent settings

- Connections share an inference-only endpoint with another device. Inference
  credentials do not authorize agent execution or model/file administration.
- Provider roles select a leader, ordered availability backups, and explicit
  advisory/handoff escalation. The same provider can serve different roles.
- Access mode governs tools on a named execution host. A remote inference model
  does not move tools to its server or gain additional permissions.

The existing `ods/current`, `local` and `default` aliases, global `ODS_MODE`,
owner model/memory choices and existing installations must remain unchanged
until the owner explicitly activates a compatible Pixel-scoped configuration.
Missing configuration preserves existing behavior; corrupt configuration is an
error, not permission to silently reset to defaults.

## Contracts under development

`bin/pixel_provider/` contains shared Python domain contracts for profile/role
validation, private revisioned persistence and fail-closed activity assessment.
These are host-side building blocks, not an alternate agent or work-provider
authority system. Inference route policy grants no tool or operating-system
privilege. Credentials are represented only by opaque server-side references;
public projections expose credential presence, not references or values.

Activity proof distinguishes busy, idle and unknown and binds observations to
a runtime epoch and freshness interval. Every chat, API, cron and background
run counts. Unknown activity blocks access transitions in either direction.
Live transition integration must prevent new admissions while draining and
must verify effective permissions before showing a confirmed mode.

## Delivery gates

- [ ] Inference-only sharing, pairing, revocation and a real laptop-to-tower task.
- [ ] Authenticated provider Settings and durable migration/rollback.
- [ ] Pixel-scoped runtime route with bounded failure/cancellation handling.
- [ ] Backup after partial progress without repeating completed tool effects.
- [ ] Explicit advisory and leader-handoff escalation with approved data scope.
- [ ] Coordinated Full Access configuration/service/guard transition and restore.
- [ ] Explicit administrative privilege and native-platform adapters.
- [ ] Current-source fresh installs, upgrades and independently verified live
      user journeys on the applicable native OS/backend/client combinations.

Full Access permits whatever the selected OS account can do. Restoring sandbox
policy does not undo host changes, transmitted data or persistence. WSL access
is not proof of Windows Administrator or native desktop control.

## Development validation

Run the focused, service-independent contract tests from `ods/`:

```sh
python3 -m unittest discover -s tests -p 'test_pixel_*.py' -v
```

These tests are necessary but are not installed-runtime or release acceptance.
