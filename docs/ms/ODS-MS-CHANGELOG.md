# ODS -> MS Ops Centre Change History

This file is the canonical continuous history of Modern Solutions changes
to the upstream ODS-based platform.

Any behavioral, runtime, deployment, policy, security, routing or integration
change must be recorded here in the same commit/PR that makes the change.

---

## Entry Template

## YYYY-MM-DD — <short title>

### Change ID
MSODS-####

### Agent / Author
<name/model>

### Branch / PR
<branch / PR>

### ODS baseline
<tag / upstream SHA>

### Classification
CONFIGURE | EXTEND | CORE CHANGE | REJECT

### Files changed
- <path>

### Reason
<why>

### MS requirement / ADR
<reference>

### Behavior before
<before>

### Behavior after
<after>

### Security / privacy impact
<impact>

### Upgrade / upstream impact
<impact>

### Validation performed
<commands/tests/results>

### Rollback
<rollback>

### Notes
<notes>

## 2026-08-16 — Establish MS Ops Centre fork governance

### Change ID
MSODS-0001

### Agent / Author
Human

### Branch / PR
docs/ms-foundation

### ODS baseline
v2.6.0

### Classification
EXTEND

### Files changed
- docs/ms/ODS-MS-CHANGELOG.md
- docs/ms/decisions/ODS-ADOPTION.md

### Reason
Establish the Modern Solutions governance and historical tracking layer without
changing ODS runtime behavior.

### MS requirement / ADR
ODS adoption decision.

### Behavior before
Upstream ODS repository had no Modern Solutions-specific governance or change history.

### Behavior after
The fork contains a canonical MS decision record and mandatory continuous change log.

### Security / privacy impact
None.

### Upgrade / upstream impact
Low. Additive MS documentation only.

### Validation performed
Verified files exist and are tracked by Git.

### Rollback
Remove docs/ms additions.

### Notes
All future behavioral MS changes must update this file in the same PR.
