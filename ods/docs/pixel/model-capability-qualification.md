# Pixel model capability qualification

ODS does not infer Pixel readiness from direct chat, route, load, ODS Talk, or
generic agent evidence. Pixel readiness is a separate, fail-closed catalog
verdict under `app_compatibility.pixel_agent`.

## Qualification bar

A model is `verified` for Pixel only when a real Pixel turn on the named host
and runtime does all of the following:

1. Understands a bounded owner request without inventing a different contract.
2. Uses Pixel's real tools to create or modify the requested workspace
   artifacts.
3. Starts the exact requested verification command in the background and polls
   it to a terminal result.
4. Diagnoses and repairs a failure without weakening the owner's assertions or
   destroying unrelated work.
5. Finishes with a concise, accurate owner-facing result and never claims
   success without a terminal zero exit.
6. Survives an independent replay of the requested verification outside the
   model turn.

`not_agent_viable` means a real Pixel turn failed that bar. `unknown` means no
matching host-scoped Pixel qualification exists. Neither status is eligible for
the Pixel default-model selector.

## 2026-08-30 Windows laptop probe

The probe ran through the installed ODS Pixel UI on WSL2 Ubuntu 24.04 with an
NVIDIA 8 GB GPU and a 64K active context. The installed ODS source was
`df05a732ed7aedac6c527e1f9e7eeeeccfed3a5b`; the installed Pixel source was
`f1f811d02bffd5a1589eb6feb34323f6dadf7832`.

Each model received a clean `/workspace/pixel_<model>_probe` directory and the
same task: implement a standard-library TTL/LRU cache plus deterministic
unittests, run exactly `python3 -m unittest -v` as a background command, poll it
to completion, repair failures, and report only verified truth.

### NVIDIA Nemotron 3 Nano 4B

- Pixel session: `c6de656b-4b30-4b94-951f-55e2d6beb16f`
- The model created an implementation and tests but ignored the injected fake
  clock, copied test behavior into implementation details, used real sleeping,
  and did not implement correct LRU/size semantics.
- It ran tests twice, observed failures, emitted a long circular response, and
  made no useful repair or concise honest terminal report.
- Independent replay of `python3 -m unittest -v` ran five tests with two
  failures.
- Verdict: `not_agent_viable` on `windows-laptop` for this runtime.

### Qwen 3.5 4B

- Pixel session: `7f9cb5c6-b64e-41e3-bc2e-ad24013e33a5`
- The model created both files and launched a background unittest command, but
  the suite failed with an undefined `time` name.
- It made one ineffective duplicate edit, reached the bounded tool circuit
  breaker, and ended without a rerun or an honest terminal result.
- Independent replay of `python3 -m unittest -v` still failed with the same
  `NameError`; the implementation also invented a bytes-only contract and had
  incorrect overwrite-at-capacity behavior.
- Verdict: `not_agent_viable` on `windows-laptop` for this runtime.

### Qwen 2.5 Coder 3B 128K

- Pixel session: `0e477566-5158-425d-a54c-666eb0887481`
- The model made no tool calls and created no files.
- It returned malformed mock protocol text labeled as example conversation,
  code, and reply instead of operating Pixel.
- Verdict: `not_agent_viable` on `windows-laptop` for this runtime.

### Ministral 3 8B Instruct 2512

- Pixel session: `f150ff79-c88e-4b12-a564-0769fd52a6a8`
- The real tool-loop generation rate fell to roughly 2.5 tok/s after the
  shallow Models-page activation probe had reported 15.1 tok/s.
- The model wrote the implementation in the requested directory but wrote the
  tests to a misspelled sibling directory. It then ran a different unittest
  command than requested, received an import failure, hallucinated a filename
  correction, emitted an invalid patch, attempted a no-op edit against a
  missing file, and recursively deleted the requested project tree without the
  owner asking for deletion.
- It eventually recreated both requested artifacts and polled the exact
  background command to terminal completion, but seven tests finished with two
  failures: TTL expiry was refreshed incorrectly and `__len__` did not reclaim
  expired entries. Independent replay reproduced the same two failures.
- Its attempted repair duplicated the clock read, did not address expired-entry
  reclamation, and the following model request timed out. Pixel returned to
  `Available` without any owner-facing terminal report.
- No verified passing result was produced.
- Verdict: `not_agent_viable` on `windows-laptop` for this runtime.

## Revalidation

A model may be promoted only by a later evidence entry that names the exact ODS
and Pixel source revisions, host scope, model artifact, runtime profile, active
context, Pixel session, terminal verification result, and independent replay.
Changing a prompt, plugin, model artifact, runtime profile, or context can
justify revalidation; it does not erase prior scoped failure evidence.
