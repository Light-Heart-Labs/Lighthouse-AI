# ODS Adoption Decision

Date: 2026-08-16

Modern Solutions will develop MS Ops Centre as a true fork of Osmantic/ODS.

Active repository:
Modern-Solutions-B-V/ops-centre

Historical repository:
Modern-Solutions-B-V/ms-ops-centre

The historical repository remains reference-only and preserves the original
architecture, ADRs, qualification work and pre-ODS execution path.

ODS stable release v2.6.0 is the initial substrate baseline.

Design principles:

1. MS requirements, security policy and qualification criteria remain authoritative.
2. Prefer CONFIGURE over EXTEND, and EXTEND over CORE CHANGE.
3. Preserve upstream mergeability.
4. Install and evaluate the broad ODS capability set from QR1.
5. Trust and permissions are progressively enabled through machine-enforced policy.
6. Every MS behavioral change to the ODS fork must be recorded in
   docs/ms/ODS-MS-CHANGELOG.md.
