# Merged Upstream PRs

Tracks which `Osmantic/ODS` pull requests have been evaluated and ported into
this fork's `main`, so a future porting session can resume from where this one
left off instead of re-deriving state. See `CLAUDE.md` for the pointer to this
file, and `ods/scripts/` for the two-pass porting scripts referenced below.

## Process (2026-08-10 batch)

1. **Candidate filter**: open, non-draft PRs on `Osmantic/ODS` titled `fix(...)`,
   excluding PRs authored by `azilber`.
2. **Version gate**: only PRs whose branch is a descendant of the `v2.6.0` tag
   qualify (`git merge-base --is-ancestor v2.6.0 <branch>`) — this repo was
   renamed from `DreamServer` to `ODS` at v2.5.3, and PRs opened before that
   rename conflict against the current layout in ways that silently reintroduce
   stale pre-rename code (verified the hard way — see git history around
   2026-08-09). PRs failing this check are **not yet processed**, not rejected;
   they become eligible once rebased past `v2.6.0`, or once upstream closes them.
3. **Merge + gates**: for each qualifying PR, merge against current `main`;
   verify `make lint` passes, no new top-level directory appears (structural
   check), and no added line reintroduces a pre-rename identifier (legacy-token
   check). Conflicts are auto-resolved by taking the incoming side only when
   that side's content doesn't overlap with anything this fork already merged.
4. **Conflict retry pass**: PRs that conflicted with a file another PR *from the
   same run* had just changed are retried once that earlier port is in `main`.
   Each conflicting hunk is classified: textually disjoint hunks are unioned
   (both kept) and re-verified through the same gates; hunks that closely
   resemble an already-merged fix are left alone (`Superseded` below) rather
   than guessed at.

## Merged (265)

| Upstream PR | Title | Fork PR |
|---|---|---|
| [#2661](https://github.com/Osmantic/ODS/pull/2661) | fix(models): fall back to effective mode when .env is unreadable (rootless Docker) | [#3](https://github.com/azilber/ODS/pull/3) |
| [#2662](https://github.com/Osmantic/ODS/pull/2662) | fix(host-agent): make the host agent reachable under Docker rootless | [#4](https://github.com/azilber/ODS/pull/4) |
| [#1661](https://github.com/Osmantic/ODS/pull/1661) | fix(windows): handle multiple Python executables returned by Get-Command | [#10](https://github.com/azilber/ODS/pull/10) |
| [#1797](https://github.com/Osmantic/ODS/pull/1797) | fix(cold-storage): verify archive/restore moves and create cold dir | [#11](https://github.com/azilber/ODS/pull/11) |
| [#1799](https://github.com/Osmantic/ODS/pull/1799) | fix(release-gate): report cleanly when a version file is missing | [#12](https://github.com/azilber/ODS/pull/12) |
| [#1800](https://github.com/Osmantic/ODS/pull/1800) | fix(service-registry): stop cache counters aborting set -e callers | [#13](https://github.com/azilber/ODS/pull/13) |
| [#1919](https://github.com/Osmantic/ODS/pull/1919) | fix(host-agent): write the model-state record under ODS_DATA_DIR | [#14](https://github.com/azilber/ODS/pull/14) |
| [#1924](https://github.com/Osmantic/ODS/pull/1924) | fix(resolver): restore user-extension compose guard parity with the API | [#15](https://github.com/azilber/ODS/pull/15) |
| [#2012](https://github.com/Osmantic/ODS/pull/2012) | fix(ape): prune governance state on save, not only on load | [#16](https://github.com/azilber/ODS/pull/16) |
| [#2013](https://github.com/Osmantic/ODS/pull/2013) | fix(amd-topo): report PCIe generation and lane count in the shared schema | [#17](https://github.com/azilber/ODS/pull/17) |
| [#2014](https://github.com/Osmantic/ODS/pull/2014) | fix(installer): answer for the current run's background tasks | [#18](https://github.com/azilber/ODS/pull/18) |
| [#2020](https://github.com/Osmantic/ODS/pull/2020) | fix(security): create credential files owner-only, not after the fact | [#19](https://github.com/azilber/ODS/pull/19) |
| [#2023](https://github.com/Osmantic/ODS/pull/2023) | fix(token-spy): keep tool-call chains intact when trimming history | [#20](https://github.com/azilber/ODS/pull/20) |
| [#2025](https://github.com/Osmantic/ODS/pull/2025) | fix(token-spy): stop the SSE token stream re-sending every event | [#21](https://github.com/azilber/ODS/pull/21) |
| [#2029](https://github.com/Osmantic/ODS/pull/2029) | fix(dashboard): make the GPU topology legend match the matrix colours | [#22](https://github.com/azilber/ODS/pull/22) |
| [#2070](https://github.com/Osmantic/ODS/pull/2070) | fix(memory-shepherd): stop a blocked run deleting the live lock | [#23](https://github.com/azilber/ODS/pull/23) |
| [#2073](https://github.com/Osmantic/ODS/pull/2073) | fix(deps): build the core-service list from the services block only | [#24](https://github.com/azilber/ODS/pull/24) |
| [#2085](https://github.com/Osmantic/ODS/pull/2085) | fix(privacy-shield): scrub compressed IPv6 addresses whole | [#25](https://github.com/azilber/ODS/pull/25) |
| [#2086](https://github.com/Osmantic/ODS/pull/2086) | fix(litellm): map async call types to the right telemetry endpoint | [#273](https://github.com/azilber/ODS/pull/273) |
| [#2098](https://github.com/Osmantic/ODS/pull/2098) | fix(dashboard): show days in the Settings uptime | [#27](https://github.com/azilber/ODS/pull/27) |
| [#2124](https://github.com/Osmantic/ODS/pull/2124) | fix(dashboard-api): stop recommending models the catalog has retired | [#28](https://github.com/azilber/ODS/pull/28) |
| [#2126](https://github.com/Osmantic/ODS/pull/2126) | fix(dashboard-api): resolve MODEL_PROFILE=auto against the detected backend | [#246](https://github.com/azilber/ODS/pull/246) |
| [#2178](https://github.com/Osmantic/ODS/pull/2178) | fix(windows): size the disk preflight to the selected model | [#29](https://github.com/azilber/ODS/pull/29) |
| [#2188](https://github.com/Osmantic/ODS/pull/2188) | fix(windows): write ODS_DEVICE_NAME and HOST_LAN_IP to .env | [#30](https://github.com/azilber/ODS/pull/30) |
| [#2266](https://github.com/Osmantic/ODS/pull/2266) | fix(upgrade): atomically replace model-update .env files | [#31](https://github.com/azilber/ODS/pull/31) |
| [#2268](https://github.com/Osmantic/ODS/pull/2268) | fix(upgrade): avoid shell parsing Hermes live patches | [#32](https://github.com/azilber/ODS/pull/32) |
| [#2269](https://github.com/Osmantic/ODS/pull/2269) | fix(installer): escape Hermes fallback substitutions | [#33](https://github.com/azilber/ODS/pull/33) |
| [#2287](https://github.com/Osmantic/ODS/pull/2287) | fix(compose): resolve stack from script root | [#34](https://github.com/azilber/ODS/pull/34) |
| [#2290](https://github.com/Osmantic/ODS/pull/2290) | fix(config): preserve unmatched env quotes | [#35](https://github.com/azilber/ODS/pull/35) |
| [#2291](https://github.com/Osmantic/ODS/pull/2291) | fix(sessions): commit index before pruning files | [#36](https://github.com/azilber/ODS/pull/36) |
| [#2292](https://github.com/Osmantic/ODS/pull/2292) | fix(llama): respect GPU layer placement | [#37](https://github.com/azilber/ODS/pull/37) |
| [#2293](https://github.com/Osmantic/ODS/pull/2293) | fix(hermes): persist dashboard websocket sessions | [#38](https://github.com/azilber/ODS/pull/38) |
| [#2294](https://github.com/Osmantic/ODS/pull/2294) | fix(installer): quote NVIDIA DKMS kernel path | [#39](https://github.com/azilber/ODS/pull/39) |
| [#2295](https://github.com/Osmantic/ODS/pull/2295) | fix(runtime): derive NVIDIA llama memory limit from host capacity | [#40](https://github.com/azilber/ODS/pull/40) |
| [#2296](https://github.com/Osmantic/ODS/pull/2296) | fix(macos): treat absent BIND_ADDRESS as loopback on installer rerun | [#41](https://github.com/azilber/ODS/pull/41) |
| [#2308](https://github.com/Osmantic/ODS/pull/2308) | fix(installer): gate Hermes 64K context floor on VRAM to stop llama-server OOM | [#42](https://github.com/azilber/ODS/pull/42) |
| [#2310](https://github.com/Osmantic/ODS/pull/2310) | fix(bootstrap): guard rm -rf against unsafe install paths (#2301) | [#43](https://github.com/azilber/ODS/pull/43) |
| [#2312](https://github.com/Osmantic/ODS/pull/2312) | fix(amd-tuning): stage the GTT modprobe config in a private temp dir | [#44](https://github.com/azilber/ODS/pull/44) |
| [#2313](https://github.com/Osmantic/ODS/pull/2313) | fix(installer): keep the background-task registry out of shared /tmp | [#247](https://github.com/azilber/ODS/pull/247) |
| [#2314](https://github.com/Osmantic/ODS/pull/2314) | fix(external-llm): read .env values the way safe-env.sh does | [#45](https://github.com/azilber/ODS/pull/45) |
| [#2317](https://github.com/Osmantic/ODS/pull/2317) | fix(compose-images): honour ODS_PYTHON_CMD given as a command name | [#46](https://github.com/azilber/ODS/pull/46) |
| [#2318](https://github.com/Osmantic/ODS/pull/2318) | fix(dashboard): label the hybrid and colocated GPU assignment plans | [#47](https://github.com/azilber/ODS/pull/47) |
| [#2320](https://github.com/Osmantic/ODS/pull/2320) | fix(qrcode): resolve format_duration so print_install_summary can run | [#48](https://github.com/azilber/ODS/pull/48) |
| [#2321](https://github.com/Osmantic/ODS/pull/2321) | fix(auth): make magic-link revocation unambiguous | [#49](https://github.com/azilber/ODS/pull/49) |
| [#2322](https://github.com/Osmantic/ODS/pull/2322) | fix(model-router): retain routes on malformed endpoint config | [#50](https://github.com/azilber/ODS/pull/50) |
| [#2323](https://github.com/Osmantic/ODS/pull/2323) | fix(setup): tolerate malformed persisted state shapes | [#51](https://github.com/azilber/ODS/pull/51) |
| [#2324](https://github.com/Osmantic/ODS/pull/2324) | fix(open-interpreter): stop stream workers after disconnect | [#52](https://github.com/azilber/ODS/pull/52) |
| [#2325](https://github.com/Osmantic/ODS/pull/2325) | fix(token-spy): harden session cleanup arguments | [#53](https://github.com/azilber/ODS/pull/53) |
| [#2326](https://github.com/Osmantic/ODS/pull/2326) | fix(macos): remove seq dependency from runtime loops | [#54](https://github.com/azilber/ODS/pull/54) |
| [#2329](https://github.com/Osmantic/ODS/pull/2329) | fix(restore): reject invalid interactive backup selections | [#55](https://github.com/azilber/ODS/pull/55) |
| [#2330](https://github.com/Osmantic/ODS/pull/2330) | fix(dashboard-api): normalize malformed bootstrap status | [#56](https://github.com/azilber/ODS/pull/56) |
| [#2331](https://github.com/Osmantic/ODS/pull/2331) | fix(remote-provider): reject non-finite SSH timing values | [#57](https://github.com/azilber/ODS/pull/57) |
| [#2333](https://github.com/Osmantic/ODS/pull/2333) | fix(dashboard): tolerate unavailable theme storage | [#58](https://github.com/azilber/ODS/pull/58) |
| [#2334](https://github.com/Osmantic/ODS/pull/2334) | fix(monitoring): clear stale cluster snapshots after probe failures | [#59](https://github.com/azilber/ODS/pull/59) |
| [#2335](https://github.com/Osmantic/ODS/pull/2335) | fix(usage): validate Token Spy report response shape | [#60](https://github.com/azilber/ODS/pull/60) |
| [#2337](https://github.com/Osmantic/ODS/pull/2337) | fix(litellm): resolve httpx.AsyncClient connection leak in ODSTokenSpyCallback (#2336) | [#61](https://github.com/azilber/ODS/pull/61) |
| [#2339](https://github.com/Osmantic/ODS/pull/2339) | fix(ssh-tunnel): log ValueError detail from _combined_ssh_argv in reconcile (#2338) | [#62](https://github.com/azilber/ODS/pull/62) |
| [#2340](https://github.com/Osmantic/ODS/pull/2340) | fix(cli): route ods rollback through ods-update.sh snapshot restore | [#63](https://github.com/azilber/ODS/pull/63) |
| [#2341](https://github.com/Osmantic/ODS/pull/2341) | fix(api): tolerate null release body in release manifest | [#64](https://github.com/azilber/ODS/pull/64) |
| [#2342](https://github.com/Osmantic/ODS/pull/2342) | fix(api): skip empty choices chunks in vision stream | [#65](https://github.com/azilber/ODS/pull/65) |
| [#2343](https://github.com/Osmantic/ODS/pull/2343) | fix(api): tolerate null statistics from n8n in workflows list | [#66](https://github.com/azilber/ODS/pull/66) |
| [#2344](https://github.com/Osmantic/ODS/pull/2344) | fix(api): read user-data files as utf-8 with error tolerance | [#67](https://github.com/azilber/ODS/pull/67) |
| [#2345](https://github.com/Osmantic/ODS/pull/2345) | fix(preflight): fail loudly when the log cannot be created | [#68](https://github.com/azilber/ODS/pull/68) |
| [#2346](https://github.com/Osmantic/ODS/pull/2346) | fix(restore): reject archives whose root doesn't match the backup id | [#69](https://github.com/azilber/ODS/pull/69) |
| [#2347](https://github.com/Osmantic/ODS/pull/2347) | fix(restore): don't wipe live config from an empty backup config dir | [#70](https://github.com/azilber/ODS/pull/70) |
| [#2348](https://github.com/Osmantic/ODS/pull/2348) | fix(migrate): stop copying DATA_DIR into itself during backup | [#71](https://github.com/azilber/ODS/pull/71) |
| [#2349](https://github.com/Osmantic/ODS/pull/2349) | fix(install): drop dead env keys from offline mode setup | [#72](https://github.com/azilber/ODS/pull/72) |
| [#2352](https://github.com/Osmantic/ODS/pull/2352) | fix(models): pin gemma4 E2B/E4B GGUF URLs to a revision and refresh checksums | [#73](https://github.com/azilber/ODS/pull/73) |
| [#2353](https://github.com/Osmantic/ODS/pull/2353) | fix(remote-provider): log invalid SSH supervisor plans | [#248](https://github.com/azilber/ODS/pull/248) |
| [#2355](https://github.com/Osmantic/ODS/pull/2355) | fix(backup): make shared rsync copies additive | [#74](https://github.com/azilber/ODS/pull/74) |
| [#2356](https://github.com/Osmantic/ODS/pull/2356) | fix(install): persist host IDs for Compose services | [#75](https://github.com/azilber/ODS/pull/75) |
| [#2357](https://github.com/Osmantic/ODS/pull/2357) | fix(embeddings): allow platform-compatible image overrides | [#76](https://github.com/azilber/ODS/pull/76) |
| [#2360](https://github.com/Osmantic/ODS/pull/2360) | fix(backup): recognize multi-segment backup IDs | [#77](https://github.com/azilber/ODS/pull/77) |
| [#2361](https://github.com/Osmantic/ODS/pull/2361) | fix(gpu): fail closed on missing NVIDIA assignment | [#78](https://github.com/azilber/ODS/pull/78) |
| [#2362](https://github.com/Osmantic/ODS/pull/2362) | fix(preset): preserve complete env values in diff | [#79](https://github.com/azilber/ODS/pull/79) |
| [#2363](https://github.com/Osmantic/ODS/pull/2363) | fix(privacy-shield): scrub API keys written with a space | [#80](https://github.com/azilber/ODS/pull/80) |
| [#2367](https://github.com/Osmantic/ODS/pull/2367) | fix(readiness): stop filing healthy containers under "needs attention" | [#81](https://github.com/azilber/ODS/pull/81) |
| [#2370](https://github.com/Osmantic/ODS/pull/2370) | fix(auth): reuse generated dashboard API keys | [#82](https://github.com/azilber/ODS/pull/82) |
| [#2372](https://github.com/Osmantic/ODS/pull/2372) | fix(models): honor installable-only fallback | [#83](https://github.com/azilber/ODS/pull/83) |
| [#2373](https://github.com/Osmantic/ODS/pull/2373) | fix(gpu): validate assignment topology inputs | [#84](https://github.com/azilber/ODS/pull/84) |
| [#2374](https://github.com/Osmantic/ODS/pull/2374) | fix(monitor): validate Token Spy summaries | [#85](https://github.com/azilber/ODS/pull/85) |
| [#2375](https://github.com/Osmantic/ODS/pull/2375) | fix(setup): validate chat completion responses | [#86](https://github.com/azilber/ODS/pull/86) |
| [#2376](https://github.com/Osmantic/ODS/pull/2376) | fix(api): validate model introspection payloads | [#87](https://github.com/azilber/ODS/pull/87) |
| [#2377](https://github.com/Osmantic/ODS/pull/2377) | fix(hermes): escape generated YAML scalars | [#88](https://github.com/azilber/ODS/pull/88) |
| [#2378](https://github.com/Osmantic/ODS/pull/2378) | fix(audit): match compose port env names exactly | [#89](https://github.com/azilber/ODS/pull/89) |
| [#2379](https://github.com/Osmantic/ODS/pull/2379) | fix(validation): use last duplicate env value | [#90](https://github.com/azilber/ODS/pull/90) |
| [#2381](https://github.com/Osmantic/ODS/pull/2381) | fix(download-artifact): write temp artifact atomically in download-hf-artifact.py | [#91](https://github.com/azilber/ODS/pull/91) |
| [#2382](https://github.com/Osmantic/ODS/pull/2382) | fix(support-bundle): write bundle evidence JSON atomically in ods-support-bundle.sh | [#92](https://github.com/azilber/ODS/pull/92) |
| [#2383](https://github.com/Osmantic/ODS/pull/2383) | fix(installers): pre-apply restricted permissions on env generator temp file | [#93](https://github.com/azilber/ODS/pull/93) |
| [#2384](https://github.com/Osmantic/ODS/pull/2384) | fix(macos): pre-apply restricted permissions on daemon PID temp file in ods-macos.sh | [#94](https://github.com/azilber/ODS/pull/94) |
| [#2385](https://github.com/Osmantic/ODS/pull/2385) | fix(dashboard-api): use mkstemp for collision-free _write_json_file helper | [#95](https://github.com/azilber/ODS/pull/95) |
| [#2386](https://github.com/Osmantic/ODS/pull/2386) | fix(dashboard-api): use mkstemp for collision-free _atomic_write_0600 helper | [#96](https://github.com/azilber/ODS/pull/96) |
| [#2387](https://github.com/Osmantic/ODS/pull/2387) | fix(card-generator): write setup card PNG and PDF atomically in generate-setup-card.py | [#97](https://github.com/azilber/ODS/pull/97) |
| [#2388](https://github.com/Osmantic/ODS/pull/2388) | fix(preflight): write preflight summary JSON atomically in linux-install-preflight.sh | [#98](https://github.com/azilber/ODS/pull/98) |
| [#2389](https://github.com/Osmantic/ODS/pull/2389) | fix(installers): write GPU topology JSON atomically in 03-features.sh | [#99](https://github.com/azilber/ODS/pull/99) |
| [#2390](https://github.com/Osmantic/ODS/pull/2390) | fix(installers): write compose flags cache atomically in 11-services.sh | [#100](https://github.com/azilber/ODS/pull/100) |
| [#2391](https://github.com/Osmantic/ODS/pull/2391) | fix(installers): write setup complete JSON atomically in 13-summary.sh | [#101](https://github.com/azilber/ODS/pull/101) |
| [#2392](https://github.com/Osmantic/ODS/pull/2392) | fix(bootstrap): write upgrade lock PID file atomically in bootstrap-upgrade.sh | [#102](https://github.com/azilber/ODS/pull/102) |
| [#2393](https://github.com/Osmantic/ODS/pull/2393) | fix(migration): write migration version state atomically in migrate-config.sh | [#103](https://github.com/azilber/ODS/pull/103) |
| [#2394](https://github.com/Osmantic/ODS/pull/2394) | fix(uninstall): remove the OpenCode config.json compat file | [#104](https://github.com/azilber/ODS/pull/104) |
| [#2395](https://github.com/Osmantic/ODS/pull/2395) | fix(macos): run OpenCode LaunchAgent with serve, not web | [#105](https://github.com/azilber/ODS/pull/105) |
| [#2396](https://github.com/Osmantic/ODS/pull/2396) | fix(uninstall): reap brew-installed OpenCode orphans | [#106](https://github.com/azilber/ODS/pull/106) |
| [#2397](https://github.com/Osmantic/ODS/pull/2397) | fix(linux): honor OPENCODE_PORT in the OpenCode systemd unit | [#107](https://github.com/azilber/ODS/pull/107) |
| [#2399](https://github.com/Osmantic/ODS/pull/2399) | fix(installer): probe OpenCode health on the configured port | [#108](https://github.com/azilber/ODS/pull/108) |
| [#2400](https://github.com/Osmantic/ODS/pull/2400) | fix(installer): print the configured OpenCode port in summary | [#109](https://github.com/azilber/ODS/pull/109) |
| [#2401](https://github.com/Osmantic/ODS/pull/2401) | fix(dashboard-api): honor OPENCODE_PORT for the OpenCode host service | [#110](https://github.com/azilber/ODS/pull/110) |
| [#2402](https://github.com/Osmantic/ODS/pull/2402) | fix(installer): clamp fresh OpenCode config output to context | [#111](https://github.com/azilber/ODS/pull/111) |
| [#2403](https://github.com/Osmantic/ODS/pull/2403) | fix(windows): clamp OpenCode config output to context | [#112](https://github.com/azilber/ODS/pull/112) |
| [#2404](https://github.com/Osmantic/ODS/pull/2404) | fix(upgrade-model): write model upgrade state JSON atomically in upgrade-model.sh | [#113](https://github.com/azilber/ODS/pull/113) |
| [#2405](https://github.com/Osmantic/ODS/pull/2405) | fix(workers): write slash workers collection file atomically in prune-hermes-slash-workers.sh | [#114](https://github.com/azilber/ODS/pull/114) |
| [#2406](https://github.com/Osmantic/ODS/pull/2406) | fix(ap-mode): write AP mode state configuration atomically in ap-mode.sh | [#115](https://github.com/azilber/ODS/pull/115) |
| [#2407](https://github.com/Osmantic/ODS/pull/2407) | fix(bootstrap): restart Windows OpenCode web after a model swap | [#116](https://github.com/azilber/ODS/pull/116) |
| [#2408](https://github.com/Osmantic/ODS/pull/2408) | fix(backup): preserve user data in migration backups | [#249](https://github.com/azilber/ODS/pull/249) |
| [#2409](https://github.com/Osmantic/ODS/pull/2409) | fix(backup): verify compressed backups by bare ID | [#117](https://github.com/azilber/ODS/pull/117) |
| [#2410](https://github.com/Osmantic/ODS/pull/2410) | fix(restore): stop containers with resolved compose stack | [#118](https://github.com/azilber/ODS/pull/118) |
| [#2411](https://github.com/Osmantic/ODS/pull/2411) | fix(dashboard): tolerate features missing requirements | [#250](https://github.com/azilber/ODS/pull/250) |
| [#2412](https://github.com/Osmantic/ODS/pull/2412) | fix(installer): detect stale background-task pids | [#251](https://github.com/azilber/ODS/pull/251) |
| [#2413](https://github.com/Osmantic/ODS/pull/2413) | fix(dashboard): tolerate magic links missing created_at | [#119](https://github.com/azilber/ODS/pull/119) |
| [#2414](https://github.com/Osmantic/ODS/pull/2414) | fix(installer): honor N8N_PORT override in Windows health probe | [#120](https://github.com/azilber/ODS/pull/120) |
| [#2415](https://github.com/Osmantic/ODS/pull/2415) | fix(installer): strip quotes when reading env values on macOS | [#121](https://github.com/azilber/ODS/pull/121) |
| [#2416](https://github.com/Osmantic/ODS/pull/2416) | fix(installer): honor dashboard port overrides in Windows conflict scan | [#122](https://github.com/azilber/ODS/pull/122) |
| [#2417](https://github.com/Osmantic/ODS/pull/2417) | fix(installer): do not abort macOS install on benign Hermes dir | [#123](https://github.com/azilber/ODS/pull/123) |
| [#2418](https://github.com/Osmantic/ODS/pull/2418) | fix(installer): point Windows dashboard shortcut and success card at resolved ports | [#124](https://github.com/azilber/ODS/pull/124) |
| [#2419](https://github.com/Osmantic/ODS/pull/2419) | fix(installer): honor WHISPER_PORT override in macOS health probe | [#125](https://github.com/azilber/ODS/pull/125) |
| [#2421](https://github.com/Osmantic/ODS/pull/2421) | fix(health): do not fail host-network services on port check | [#126](https://github.com/azilber/ODS/pull/126) |
| [#2422](https://github.com/Osmantic/ODS/pull/2422) | fix(installer): honor PERPLEXICA_PORT override in Windows auto-config | [#127](https://github.com/azilber/ODS/pull/127) |
| [#2423](https://github.com/Osmantic/ODS/pull/2423) | fix(dashboard): tolerate incomplete workflow catalog entries | [#128](https://github.com/azilber/ODS/pull/128) |
| [#2425](https://github.com/Osmantic/ODS/pull/2425) | fix(dashboard): tolerate invalid SHIELD_PORT env value | [#129](https://github.com/azilber/ODS/pull/129) |
| [#2426](https://github.com/Osmantic/ODS/pull/2426) | fix(dashboard): reap OAuth nonces with invalid timestamps | [#130](https://github.com/azilber/ODS/pull/130) |
| [#2427](https://github.com/Osmantic/ODS/pull/2427) | fix(dashboard): clean error when model record lacks gguf_file | [#252](https://github.com/azilber/ODS/pull/252) |
| [#2428](https://github.com/Osmantic/ODS/pull/2428) | fix(installer): point Linux desktop shortcut at resolved dashboard port | [#131](https://github.com/azilber/ODS/pull/131) |
| [#2429](https://github.com/Osmantic/ODS/pull/2429) | fix(installer): honor WHISPER_PORT override in Windows conflict scan | [#132](https://github.com/azilber/ODS/pull/132) |
| [#2430](https://github.com/Osmantic/ODS/pull/2430) | fix(installer): resolve dashboard ports in macOS readiness summary | [#133](https://github.com/azilber/ODS/pull/133) |
| [#2431](https://github.com/Osmantic/ODS/pull/2431) | fix(installer): honor LITELLM_PORT override in macOS cloud health | [#134](https://github.com/azilber/ODS/pull/134) |
| [#2432](https://github.com/Osmantic/ODS/pull/2432) | fix(token-spy): use portable stat on macOS session cleanup | [#135](https://github.com/azilber/ODS/pull/135) |
| [#2433](https://github.com/Osmantic/ODS/pull/2433) | fix(restore): estimate tar size portably on macOS | [#136](https://github.com/azilber/ODS/pull/136) |
| [#2435](https://github.com/Osmantic/ODS/pull/2435) | fix(catalog): write generated extensions catalog JSON atomically in generate-extensions-catalog.py | [#137](https://github.com/azilber/ODS/pull/137) |
| [#2436](https://github.com/Osmantic/ODS/pull/2436) | fix(install-context): write installation context atomically in build-installation-context.py | [#138](https://github.com/azilber/ODS/pull/138) |
| [#2437](https://github.com/Osmantic/ODS/pull/2437) | fix(dashboard-api): write setup wizard state files atomically in setup.py | [#139](https://github.com/azilber/ODS/pull/139) |
| [#2438](https://github.com/Osmantic/ODS/pull/2438) | fix(doctor): write doctor diagnostic report JSON atomically in ods-doctor.sh | [#140](https://github.com/azilber/ODS/pull/140) |
| [#2439](https://github.com/Osmantic/ODS/pull/2439) | fix(preflight): write preflight engine report JSON atomically in preflight-engine.sh | [#141](https://github.com/azilber/ODS/pull/141) |
| [#2440](https://github.com/Osmantic/ODS/pull/2440) | fix(simulators): write simulated installer report JSON atomically in simulate-installers.sh | [#142](https://github.com/azilber/ODS/pull/142) |
| [#2441](https://github.com/Osmantic/ODS/pull/2441) | fix(support-bundle): write bundle manifest JSON atomically in ods-support-bundle.sh | [#143](https://github.com/azilber/ODS/pull/143) |
| [#2442](https://github.com/Osmantic/ODS/pull/2442) | fix(token-spy): pre-apply restricted permissions on API key temp file in token-spy | [#144](https://github.com/azilber/ODS/pull/144) |
| [#2445](https://github.com/Osmantic/ODS/pull/2445) | fix(installer): write OpenCode configuration atomically with restricted permissions in install-macos.sh | [#145](https://github.com/azilber/ODS/pull/145) |
| [#2449](https://github.com/Osmantic/ODS/pull/2449) | fix(migrations): write migration state file atomically in migrate-config.sh | [#253](https://github.com/azilber/ODS/pull/253) |
| [#2450](https://github.com/Osmantic/ODS/pull/2450) | fix(ape): allowlist every command in the string, not just the first | [#146](https://github.com/azilber/ODS/pull/146) |
| [#2451](https://github.com/Osmantic/ODS/pull/2451) | fix(ape): classify an edit as a write, not a read | [#147](https://github.com/azilber/ODS/pull/147) |
| [#2452](https://github.com/Osmantic/ODS/pull/2452) | fix(models): pin the tier-0 and Windows coder-next GGUF checksums | [#148](https://github.com/azilber/ODS/pull/148) |
| [#2453](https://github.com/Osmantic/ODS/pull/2453) | fix(backup): pre-secure backup archive permissions before compression in ods-backup.sh | [#149](https://github.com/azilber/ODS/pull/149) |
| [#2454](https://github.com/Osmantic/ODS/pull/2454) | fix(restore): exit subshell with error code on checksum mismatch in ods-restore.sh | [#150](https://github.com/azilber/ODS/pull/150) |
| [#2455](https://github.com/Osmantic/ODS/pull/2455) | fix(update): preserve docker-compose override stack resolution in ods-update.sh | [#151](https://github.com/azilber/ODS/pull/151) |
| [#2456](https://github.com/Osmantic/ODS/pull/2456) | fix(uninstall): add path safety validation for INSTALL_DIR in ods-uninstall.sh | [#152](https://github.com/azilber/ODS/pull/152) |
| [#2457](https://github.com/Osmantic/ODS/pull/2457) | fix(preflight): ensure bash 3.2 compatibility in is_external_lemonade helper in ods-preflight.sh | [#153](https://github.com/azilber/ODS/pull/153) |
| [#2458](https://github.com/Osmantic/ODS/pull/2458) | fix(gpus): validate positive model size in assign_gpus.py | [#254](https://github.com/azilber/ODS/pull/254) |
| [#2461](https://github.com/Osmantic/ODS/pull/2461) | fix(dashboard-api): terminate cluster status subprocess on timeout in agent_monitor.py | [#154](https://github.com/azilber/ODS/pull/154) |
| [#2462](https://github.com/Osmantic/ODS/pull/2462) | fix(dashboard-api): handle invalid JSON decode in model_state.py | [#155](https://github.com/azilber/ODS/pull/155) |
| [#2465](https://github.com/Osmantic/ODS/pull/2465) | fix(env): skip all readonly Bash variables | [#156](https://github.com/azilber/ODS/pull/156) |
| [#2466](https://github.com/Osmantic/ODS/pull/2466) | fix(dashboard-api): catch socket timeout in AMD health probe in gpu.py | [#157](https://github.com/azilber/ODS/pull/157) |
| [#2467](https://github.com/Osmantic/ODS/pull/2467) | fix(mode): honor last duplicate env value | [#158](https://github.com/azilber/ODS/pull/158) |
| [#2468](https://github.com/Osmantic/ODS/pull/2468) | fix(updates): validate GitHub release payloads | [#255](https://github.com/azilber/ODS/pull/255) |
| [#2469](https://github.com/Osmantic/ODS/pull/2469) | fix(workflows): validate n8n list responses | [#159](https://github.com/azilber/ODS/pull/159) |
| [#2470](https://github.com/Osmantic/ODS/pull/2470) | fix(bootstrap): read effective env values | [#160](https://github.com/azilber/ODS/pull/160) |
| [#2471](https://github.com/Osmantic/ODS/pull/2471) | fix(models): validate benchmark introspection payloads | [#161](https://github.com/azilber/ODS/pull/161) |
| [#2472](https://github.com/Osmantic/ODS/pull/2472) | fix(privacy): validate shield statistics | [#162](https://github.com/azilber/ODS/pull/162) |
| [#2474](https://github.com/Osmantic/ODS/pull/2474) | fix(dashboard-api): use explicit UTF-8 decoding when reading version file in node.py | [#163](https://github.com/azilber/ODS/pull/163) |
| [#2475](https://github.com/Osmantic/ODS/pull/2475) | fix(health): emit standalone JSON output | [#164](https://github.com/azilber/ODS/pull/164) |
| [#2478](https://github.com/Osmantic/ODS/pull/2478) | fix(migrate): compare prerelease versions safely | [#165](https://github.com/azilber/ODS/pull/165) |
| [#2479](https://github.com/Osmantic/ODS/pull/2479) | fix(download): reject decoded artifact traversal | [#166](https://github.com/azilber/ODS/pull/166) |
| [#2480](https://github.com/Osmantic/ODS/pull/2480) | fix(healthcheck): reject non-finite timeouts | [#167](https://github.com/azilber/ODS/pull/167) |
| [#2482](https://github.com/Osmantic/ODS/pull/2482) | fix(hermes): reject non-positive runtime limits | [#168](https://github.com/azilber/ODS/pull/168) |
| [#2483](https://github.com/Osmantic/ODS/pull/2483) | fix(runtime): validate rendered numeric settings | [#169](https://github.com/azilber/ODS/pull/169) |
| [#2484](https://github.com/Osmantic/ODS/pull/2484) | fix(simulation): validate timestamp calendar dates | [#170](https://github.com/azilber/ODS/pull/170) |
| [#2490](https://github.com/Osmantic/ODS/pull/2490) | fix(embeddings): make platform arch configurable | [#256](https://github.com/azilber/ODS/pull/256) |
| [#2493](https://github.com/Osmantic/ODS/pull/2493) | fix(ci): review the PR head on @claude-review comments | [#171](https://github.com/azilber/ODS/pull/171) |
| [#2494](https://github.com/Osmantic/ODS/pull/2494) | fix(compose): select GPU overlay by backend, not tier | [#172](https://github.com/azilber/ODS/pull/172) |
| [#2495](https://github.com/Osmantic/ODS/pull/2495) | fix(workflows): resolve the kokoro dependency to the tts service | [#257](https://github.com/azilber/ODS/pull/257) |
| [#2504](https://github.com/Osmantic/ODS/pull/2504) | fix(dashboard-api): add safe float parsing for throughput values in agents.py | [#173](https://github.com/azilber/ODS/pull/173) |
| [#2507](https://github.com/Osmantic/ODS/pull/2507) | fix(dashboard-api): parse LEMONADE_TIMEOUT environment variable in lemonade_client.py | [#174](https://github.com/azilber/ODS/pull/174) |
| [#2510](https://github.com/Osmantic/ODS/pull/2510) | fix(dashboard-api): ignore commented lines in read_env_file_value in performance_oracle.py | [#175](https://github.com/azilber/ODS/pull/175) |
| [#2511](https://github.com/Osmantic/ODS/pull/2511) | fix(token-spy): price Claude 3.x models instead of billing them at zero | [#258](https://github.com/azilber/ODS/pull/258) |
| [#2512](https://github.com/Osmantic/ODS/pull/2512) | fix(external-llm): match Ollama models carrying the default :latest tag | [#176](https://github.com/azilber/ODS/pull/176) |
| [#2513](https://github.com/Osmantic/ODS/pull/2513) | fix(dashboard-api): ignore whitespace and comments in _find_env_file_value in config.py | [#177](https://github.com/azilber/ODS/pull/177) |
| [#2514](https://github.com/Osmantic/ODS/pull/2514) | fix(dashboard-api): handle permission errors during file existence check in gguf_inspector.py | [#178](https://github.com/azilber/ODS/pull/178) |
| [#2515](https://github.com/Osmantic/ODS/pull/2515) | fix(dashboard): report the model size the installer recorded | [#179](https://github.com/azilber/ODS/pull/179) |
| [#2516](https://github.com/Osmantic/ODS/pull/2516) | fix(gguf): correct the Q8_0 / Q5_0 / Q5_1 quantization labels | [#180](https://github.com/azilber/ODS/pull/180) |
| [#2517](https://github.com/Osmantic/ODS/pull/2517) | fix(settings): route seven editable keys to the service that reads them | [#181](https://github.com/azilber/ODS/pull/181) |
| [#2518](https://github.com/Osmantic/ODS/pull/2518) | fix(settings): recreate every service that reads LLM_API_URL | [#259](https://github.com/azilber/ODS/pull/259) |
| [#2519](https://github.com/Osmantic/ODS/pull/2519) | fix(token-spy): stop billing OpenAI cached tokens twice | [#260](https://github.com/azilber/ODS/pull/260) |
| [#2520](https://github.com/Osmantic/ODS/pull/2520) | fix(dashboard): validate llama introspection payloads | [#261](https://github.com/azilber/ODS/pull/261) |
| [#2522](https://github.com/Osmantic/ODS/pull/2522) | fix(auth): fail closed on invalid magic-link expiry | [#182](https://github.com/azilber/ODS/pull/182) |
| [#2523](https://github.com/Osmantic/ODS/pull/2523) | fix(oauth): confine credential discovery to roots | [#183](https://github.com/azilber/ODS/pull/183) |
| [#2524](https://github.com/Osmantic/ODS/pull/2524) | fix(extensions): validate catalog payload shape | [#262](https://github.com/azilber/ODS/pull/262) |
| [#2525](https://github.com/Osmantic/ODS/pull/2525) | fix(config): validate core service registry | [#263](https://github.com/azilber/ODS/pull/263) |
| [#2526](https://github.com/Osmantic/ODS/pull/2526) | fix(gpu): validate persisted state payloads | [#184](https://github.com/azilber/ODS/pull/184) |
| [#2528](https://github.com/Osmantic/ODS/pull/2528) | fix(privacy): validate IP address candidates | [#264](https://github.com/azilber/ODS/pull/264) |
| [#2529](https://github.com/Osmantic/ODS/pull/2529) | fix(auth): require integer session TTLs | [#185](https://github.com/azilber/ODS/pull/185) |
| [#2534](https://github.com/Osmantic/ODS/pull/2534) | fix(talk): trim backend URL settings | [#265](https://github.com/azilber/ODS/pull/265) |
| [#2535](https://github.com/Osmantic/ODS/pull/2535) | fix(config): confine generated contract paths | [#186](https://github.com/azilber/ODS/pull/186) |
| [#2536](https://github.com/Osmantic/ODS/pull/2536) | fix(release): confine golden path files | [#187](https://github.com/azilber/ODS/pull/187) |
| [#2537](https://github.com/Osmantic/ODS/pull/2537) | fix(deps): confine dependency lock paths | [#188](https://github.com/azilber/ODS/pull/188) |
| [#2538](https://github.com/Osmantic/ODS/pull/2538) | fix(extensions): reject duplicate catalog ids | [#189](https://github.com/azilber/ODS/pull/189) |
| [#2541](https://github.com/Osmantic/ODS/pull/2541) | fix(bootstrap): refuse to rm -rf a dangerous ODS_INSTALL_DIR | [#266](https://github.com/azilber/ODS/pull/266) |
| [#2544](https://github.com/Osmantic/ODS/pull/2544) | fix(backup): recognize multi-segment user-named backup IDs | [#267](https://github.com/azilber/ODS/pull/267) |
| [#2549](https://github.com/Osmantic/ODS/pull/2549) | fix(models): handle file and decode errors in load_catalog in select-model.py | [#190](https://github.com/azilber/ODS/pull/190) |
| [#2550](https://github.com/Osmantic/ODS/pull/2550) | fix(dashboard-api): ignore whitespace and comments in _read_current_version in updates.py | [#191](https://github.com/azilber/ODS/pull/191) |
| [#2551](https://github.com/Osmantic/ODS/pull/2551) | fix(dashboard-api): guard against None memory values in calculate_feature_status in features.py | [#192](https://github.com/azilber/ODS/pull/192) |
| [#2563](https://github.com/Osmantic/ODS/pull/2563) | fix(opencode): prune stale model entries in Windows config upsert | [#193](https://github.com/azilber/ODS/pull/193) |
| [#2565](https://github.com/Osmantic/ODS/pull/2565) | fix(opencode): map OPENCODE_ keys to the opencode service on apply | [#194](https://github.com/azilber/ODS/pull/194) |
| [#2566](https://github.com/Osmantic/ODS/pull/2566) | fix(opencode): drop erroneous VRAM gate on the coding feature | [#195](https://github.com/azilber/ODS/pull/195) |
| [#2567](https://github.com/Osmantic/ODS/pull/2567) | fix(opencode): mark loopback-managed coding surface as unauthenticated | [#196](https://github.com/azilber/ODS/pull/196) |
| [#2568](https://github.com/Osmantic/ODS/pull/2568) | fix(opencode): add small_model to flat render config | [#197](https://github.com/azilber/ODS/pull/197) |
| [#2569](https://github.com/Osmantic/ODS/pull/2569) | fix(uninstall): surgically remove both OpenCode config docs | [#268](https://github.com/azilber/ODS/pull/268) |
| [#2571](https://github.com/Osmantic/ODS/pull/2571) | fix(opencode): drop empty container_name and correct unit path | [#198](https://github.com/azilber/ODS/pull/198) |
| [#2573](https://github.com/Osmantic/ODS/pull/2573) | fix(context): validate model discovery payloads | [#199](https://github.com/azilber/ODS/pull/199) |
| [#2574](https://github.com/Osmantic/ODS/pull/2574) | fix(schema): confine mirror contract paths | [#200](https://github.com/azilber/ODS/pull/200) |
| [#2575](https://github.com/Osmantic/ODS/pull/2575) | fix(release): confine compatibility contract paths | [#201](https://github.com/azilber/ODS/pull/201) |
| [#2576](https://github.com/Osmantic/ODS/pull/2576) | fix(card): reject unusable onboarding URLs | [#202](https://github.com/azilber/ODS/pull/202) |
| [#2577](https://github.com/Osmantic/ODS/pull/2577) | fix(healthcheck): bound expected HTTP statuses | [#203](https://github.com/azilber/ODS/pull/203) |
| [#2578](https://github.com/Osmantic/ODS/pull/2578) | fix(healthcheck): support bracketed IPv6 targets | [#204](https://github.com/azilber/ODS/pull/204) |
| [#2579](https://github.com/Osmantic/ODS/pull/2579) | fix(resources): validate container stats payloads | [#205](https://github.com/azilber/ODS/pull/205) |
| [#2580](https://github.com/Osmantic/ODS/pull/2580) | fix(gpu): validate host metrics response root | [#206](https://github.com/azilber/ODS/pull/206) |
| [#2581](https://github.com/Osmantic/ODS/pull/2581) | fix(health): validate host-agent payload roots | [#207](https://github.com/azilber/ODS/pull/207) |
| [#2582](https://github.com/Osmantic/ODS/pull/2582) | fix(models): validate agent status response root | [#208](https://github.com/azilber/ODS/pull/208) |
| [#2589](https://github.com/Osmantic/ODS/pull/2589) | fix(opencode): use llama-server host port default in Linux route | [#209](https://github.com/azilber/ODS/pull/209) |
| [#2590](https://github.com/Osmantic/ODS/pull/2590) | fix(renderer): fall back to active model for LEMONADE_MODEL | [#210](https://github.com/azilber/ODS/pull/210) |
| [#2591](https://github.com/Osmantic/ODS/pull/2591) | fix(renderer): drop retry loop from atomic write | [#211](https://github.com/azilber/ODS/pull/211) |
| [#2592](https://github.com/Osmantic/ODS/pull/2592) | fix(uninstall): keep resolver and overlay GPU backend in lockstep | [#212](https://github.com/azilber/ODS/pull/212) |
| [#2593](https://github.com/Osmantic/ODS/pull/2593) | fix(settings): exclude live-read keys from changed-key status | [#213](https://github.com/azilber/ODS/pull/213) |
| [#2594](https://github.com/Osmantic/ODS/pull/2594) | fix(renderer): use container-service default for litellm base | [#214](https://github.com/azilber/ODS/pull/214) |
| [#2597](https://github.com/Osmantic/ODS/pull/2597) | fix(macos): force-recreate containers on restart | [#215](https://github.com/azilber/ODS/pull/215) |
| [#2602](https://github.com/Osmantic/ODS/pull/2602) | fix(opencode): read Windows config with UTF-8 encoding | [#216](https://github.com/azilber/ODS/pull/216) |
| [#2603](https://github.com/Osmantic/ODS/pull/2603) | fix(opencode): fix VBS launcher quote escaping | [#217](https://github.com/azilber/ODS/pull/217) |
| [#2604](https://github.com/Osmantic/ODS/pull/2604) | fix(opencode): resolve Windows sync libs for installed tree | [#218](https://github.com/azilber/ODS/pull/218) |
| [#2605](https://github.com/Osmantic/ODS/pull/2605) | fix(opencode): wire Lemonade model id resolution into Windows config | [#219](https://github.com/azilber/ODS/pull/219) |
| [#2606](https://github.com/Osmantic/ODS/pull/2606) | fix(opencode): align bootstrap launcher python resolution with installer | [#220](https://github.com/azilber/ODS/pull/220) |
| [#2607](https://github.com/Osmantic/ODS/pull/2607) | fix(opencode): wait for bootstrap compose stack on update | [#221](https://github.com/azilber/ODS/pull/221) |
| [#2608](https://github.com/Osmantic/ODS/pull/2608) | fix(host-agent): poll the .env-resolved agent port on macOS | [#222](https://github.com/azilber/ODS/pull/222) |
| [#2609](https://github.com/Osmantic/ODS/pull/2609) | fix(host-agent): run HF dep install as the real agent user | [#223](https://github.com/azilber/ODS/pull/223) |
| [#2610](https://github.com/Osmantic/ODS/pull/2610) | fix(opencode): grant linger to the real install user | [#224](https://github.com/azilber/ODS/pull/224) |
| [#2611](https://github.com/Osmantic/ODS/pull/2611) | fix(host-agent): treat non-active opencode states as inactive | [#225](https://github.com/azilber/ODS/pull/225) |
| [#2612](https://github.com/Osmantic/ODS/pull/2612) | fix(dashboard-api): handle UnicodeDecodeError in _read_env_map_from_path in settings.py | [#226](https://github.com/azilber/ODS/pull/226) |
| [#2613](https://github.com/Osmantic/ODS/pull/2613) | fix(upgrade): include docker-compose.override.yml in compose stack resolution in upgrade-model.sh | [#227](https://github.com/azilber/ODS/pull/227) |
| [#2614](https://github.com/Osmantic/ODS/pull/2614) | fix(hardware): check file existence in nvidia sysfs loop in detect-hardware.sh | [#228](https://github.com/azilber/ODS/pull/228) |
| [#2615](https://github.com/Osmantic/ODS/pull/2615) | fix(hardware): add safe float parsing for vram_mb and ram_mb in classify-hardware.sh | [#229](https://github.com/azilber/ODS/pull/229) |
| [#2616](https://github.com/Osmantic/ODS/pull/2616) | fix(mode): write env file updates atomically in mode-switch.sh | [#230](https://github.com/azilber/ODS/pull/230) |
| [#2618](https://github.com/Osmantic/ODS/pull/2618) | fix(compat): check docs/SUPPORT-MATRIX.md existence before grep in check-compatibility.sh | [#231](https://github.com/azilber/ODS/pull/231) |
| [#2619](https://github.com/Osmantic/ODS/pull/2619) | fix(dashboard-api): add safe float timeout parsing in host_agent_client.py | [#232](https://github.com/azilber/ODS/pull/232) |
| [#2620](https://github.com/Osmantic/ODS/pull/2620) | fix(dashboard-api): use _positive_number for regex param matches in model_memory.py | [#233](https://github.com/azilber/ODS/pull/233) |
| [#2621](https://github.com/Osmantic/ODS/pull/2621) | fix(gpu): add safe float parsing for memory_free_gb in assign_gpus.py | [#234](https://github.com/azilber/ODS/pull/234) |
| [#2622](https://github.com/Osmantic/ODS/pull/2622) | fix(catalog): handle decode errors in load_manifest in generate-extensions-catalog.py | [#235](https://github.com/azilber/ODS/pull/235) |
| [#2639](https://github.com/Osmantic/ODS/pull/2639) | fix(installer): write setup-complete.json atomically in 13-summary.sh | [#269](https://github.com/azilber/ODS/pull/269) |
| [#2640](https://github.com/Osmantic/ODS/pull/2640) | fix(healthcheck): improve status range parsing error diagnostics in healthcheck.py | [#270](https://github.com/azilber/ODS/pull/270) |
| [#2641](https://github.com/Osmantic/ODS/pull/2641) | fix(download): handle externally managed python environments in pre-download.sh | [#236](https://github.com/azilber/ODS/pull/236) |
| [#2642](https://github.com/Osmantic/ODS/pull/2642) | fix(litellm): close Token Spy client when worker is cancelled | [#271](https://github.com/azilber/ODS/pull/271) |
| [#2645](https://github.com/Osmantic/ODS/pull/2645) | fix(ods-cli): split env diff on first '=' and strip CR/quotes | [#272](https://github.com/azilber/ODS/pull/272) |
| [#2646](https://github.com/Osmantic/ODS/pull/2646) | fix(host-agent): verify opencode provider npm, model name, and output limit | [#237](https://github.com/azilber/ODS/pull/237) |
| [#2650](https://github.com/Osmantic/ODS/pull/2650) | fix(upgrade): write bootstrap status JSON using mktemp in bootstrap-upgrade.sh | [#238](https://github.com/azilber/ODS/pull/238) |
| [#2651](https://github.com/Osmantic/ODS/pull/2651) | fix(test): escape quotes in json payload in ods-test-functional.sh | [#239](https://github.com/azilber/ODS/pull/239) |
| [#2652](https://github.com/Osmantic/ODS/pull/2652) | fix(preflight): expand COMPOSE_FLAGS as array parameter in ods-preflight.sh | [#240](https://github.com/azilber/ODS/pull/240) |
| [#2653](https://github.com/Osmantic/ODS/pull/2653) | fix(doctor): strip leading key whitespace in load_env_safe in ods-doctor.sh | [#241](https://github.com/azilber/ODS/pull/241) |
| [#2654](https://github.com/Osmantic/ODS/pull/2654) | fix(audit): handle decode and parse errors in load_struct_file in audit-extensions.py | [#242](https://github.com/azilber/ODS/pull/242) |
| [#2655](https://github.com/Osmantic/ODS/pull/2655) | fix(persona): catch OSError and UnicodeDecodeError in _running_services in build-installation-context.py | [#243](https://github.com/azilber/ODS/pull/243) |
| [#2656](https://github.com/Osmantic/ODS/pull/2656) | fix(card): add graceful ImportError handler for PIL and qrcode in generate-setup-card.py | [#244](https://github.com/azilber/ODS/pull/244) |
| [#2657](https://github.com/Osmantic/ODS/pull/2657) | fix(version): specify errors=replace in read_text in check-version-consistency.py | [#245](https://github.com/azilber/ODS/pull/245) |

## Superseded — not merged, deliberately (39)

Conflicted with a PR already merged from this same batch; the conflicting hunk
closely resembled the already-merged fix, so this one was left unmerged rather
than guessed at. Revisit individually if the upstream PR covers something the
merged one doesn't.

| Upstream PR | Title | Conflicted with |
|---|---|---|
| [#2311](https://github.com/Osmantic/ODS/pull/2311) | fix(gpu): keep every GPU in the hybrid llama parallelism plan | `.github/workflows/test-linux.yml` |
| [#2316](https://github.com/Osmantic/ODS/pull/2316) | fix(healthcheck): accept bracketed IPv6 targets | `.github/workflows/test-linux.yml`, `ods/scripts/healthcheck.py` |
| [#2354](https://github.com/Osmantic/ODS/pull/2354) | fix(litellm): finish Token Spy client cleanup on cancellation | `ods/extensions/services/litellm/ods_token_spy_callback.py`, `ods/extensions/services/litellm/tests/test_token_spy_callback.py` |
| [#2358](https://github.com/Osmantic/ODS/pull/2358) | fix(bootstrap): guard recursive install cleanup | `ods/get-ods.sh` |
| [#2364](https://github.com/Osmantic/ODS/pull/2364) | fix(token-spy): keep tool chains intact when trimming by size | `ods/Makefile`, `ods/extensions/services/token-spy/filters.py` |
| [#2365](https://github.com/Osmantic/ODS/pull/2365) | fix(cold-storage): make the archive path actually archive | `ods/Makefile`, `ods/scripts/llm-cold-storage.sh`, `ods/tests/test-llm-cold-storage.sh` |
| [#2366](https://github.com/Osmantic/ODS/pull/2366) | fix(memory-shepherd): stop a blocked run from clearing the held lock | `ods/Makefile`, `ods/memory-shepherd/memory-shepherd.sh`, `ods/tests/test-memory-shepherd-lock.sh` |
| [#2368](https://github.com/Osmantic/ODS/pull/2368) | fix(python): route two entry points through the shared resolver | `.github/workflows/test-linux.yml` |
| [#2398](https://github.com/Osmantic/ODS/pull/2398) | fix(macos): honor OPENCODE_PORT in the OpenCode LaunchAgent | `ods/installers/macos/install-macos.sh` |
| [#2420](https://github.com/Osmantic/ODS/pull/2420) | fix(installer): honor N8N_PORT override in macOS health and readiness | `ods/installers/macos/install-macos.sh` |
| [#2424](https://github.com/Osmantic/ODS/pull/2424) | fix(cli): wire rollback to the written rollback-point marker | `ods/ods-cli` |
| [#2434](https://github.com/Osmantic/ODS/pull/2434) | fix(hermes): write patched Hermes configuration atomically in patch-hermes-config.py | `ods/scripts/patch-hermes-config.py` |
| [#2443](https://github.com/Osmantic/ODS/pull/2443) | fix(dashboard-api): use secure mkstemp for atomic JSON writes in helpers.py | `ods/extensions/services/dashboard-api/helpers.py` |
| [#2444](https://github.com/Osmantic/ODS/pull/2444) | fix(installer): write OpenClaw configuration atomically with restricted permissions in env-generator.sh | `ods/installers/macos/lib/env-generator.sh` |
| [#2446](https://github.com/Osmantic/ODS/pull/2446) | fix(cli): write background runner PID file atomically in ods-macos.sh | `ods/installers/macos/ods-macos.sh` |
| [#2447](https://github.com/Osmantic/ODS/pull/2447) | fix(tools): write generated setup card images atomically in generate-setup-card.py | `ods/scripts/generate-setup-card.py` |
| [#2460](https://github.com/Osmantic/ODS/pull/2460) | fix(restore): preserve files created after backup | `ods/tests/test-backup-restore-roundtrip.sh` |
| [#2463](https://github.com/Osmantic/ODS/pull/2463) | fix(models): pin Gemma 4 GGUF artifacts | `ods/config/model-library.json`, `ods/tests/test-tier-map.sh` |
| [#2473](https://github.com/Osmantic/ODS/pull/2473) | fix(dashboard-api): handle encoding and permission errors in load_workflow_catalog in workflows.py | `ods/extensions/services/dashboard-api/routers/workflows.py` |
| [#2476](https://github.com/Osmantic/ODS/pull/2476) | fix(cold-storage): remove bc age dependency | `ods/Makefile`, `ods/scripts/llm-cold-storage.sh` |
| [#2485](https://github.com/Osmantic/ODS/pull/2485) | fix(config): split preset diff env values on first equals | `ods/ods-cli`, `ods/tests/test-preset-diff.sh` |
| [#2486](https://github.com/Osmantic/ODS/pull/2486) | fix(multigpu): fail closed when GPU UUIDs unset | `ods/docker-compose.multigpu-nvidia.yml` |
| [#2487](https://github.com/Osmantic/ODS/pull/2487) | fix(backup): accept multi-segment backup IDs in retention | `ods/ods-backup.sh` |
| [#2491](https://github.com/Osmantic/ODS/pull/2491) | fix(hermes): resolve Hermes/n8n UID/GID to the host user | `ods/.env.schema.json`, `ods/installers/phases/06-directories.sh`, `ods/tests/test-hermes-data-ownership.sh` |
| [#2492](https://github.com/Osmantic/ODS/pull/2492) | fix(backup): make rsync --delete opt-in | `ods/lib/rsync.sh` |
| [#2521](https://github.com/Osmantic/ODS/pull/2521) | fix(auth): validate magic-link store shape | `ods/extensions/services/dashboard-api/tests/test_magic_link.py` |
| [#2540](https://github.com/Osmantic/ODS/pull/2540) | fix(backup): stop rsync --delete from wiping live data on restore | `ods/lib/rsync.sh` |
| [#2543](https://github.com/Osmantic/ODS/pull/2543) | fix(cli): strip CR and quotes when comparing preset env values | `ods/ods-cli`, `ods/tests/test-preset-diff.sh` |
| [#2545](https://github.com/Osmantic/ODS/pull/2545) | fix(litellm): shield Token Spy client close from double cancellation | `ods/extensions/services/litellm/ods_token_spy_callback.py`, `ods/extensions/services/litellm/tests/test_token_spy_callback.py` |
| [#2546](https://github.com/Osmantic/ODS/pull/2546) | fix(remote-provider): log SSH tunnel plan argv ValueError | `ods/extensions/services/remote-provider-ssh-tunnel/app/main.py`, `ods/tests/contracts/test-remote-provider-ssh-tunnel-service.py` |
| [#2548](https://github.com/Osmantic/ODS/pull/2548) | fix(dashboard-api): specify utf-8 encoding and catch ValueError in get_bootstrap_status in helpers.py | `ods/extensions/services/dashboard-api/helpers.py` |
| [#2564](https://github.com/Osmantic/ODS/pull/2564) | fix(opencode): cap Windows output limit at the model context | `ods/installers/windows/lib/opencode-config.ps1` |
| [#2572](https://github.com/Osmantic/ODS/pull/2572) | fix(dashboard-api): specify utf-8 encoding and catch ValueError in get_active_persona_prompt in setup.py | `ods/extensions/services/dashboard-api/routers/setup.py` |
| [#2583](https://github.com/Osmantic/ODS/pull/2583) | fix(dashboard-api): add safe integer parsing for SHIELD_PORT in privacy.py | `ods/extensions/services/dashboard-api/routers/privacy.py` |
| [#2588](https://github.com/Osmantic/ODS/pull/2588) | fix(health): honor WHISPER_PORT in macOS OpenCode health probe | `ods/installers/macos/install-macos.sh` |
| [#2638](https://github.com/Osmantic/ODS/pull/2638) | fix(dashboard-api): handle UnicodeDecodeError in ClusterStatus.refresh in agent_monitor.py | `ods/extensions/services/dashboard-api/agent_monitor.py` |
| [#2643](https://github.com/Osmantic/ODS/pull/2643) | fix(ssh-tunnel): log Warning when ssh plan argv is invalid | `ods/extensions/services/remote-provider-ssh-tunnel/app/main.py` |
| [#2647](https://github.com/Osmantic/ODS/pull/2647) | fix(opencode): skip writing blank model id into Windows config | `ods/installers/windows/lib/opencode-config.ps1` |
| [#2658](https://github.com/Osmantic/ODS/pull/2658) | fix(download): cleanup temporary file on download failure in download-hf-artifact.py | `ods/scripts/download-hf-artifact.py` |

## Skipped — needs manual review (6)

Qualified (v2.6.0+) but couldn't be auto-merged cleanly. Worth a manual look.

| Upstream PR | Title | Reason |
|---|---|---|
| [#2315](https://github.com/Osmantic/ODS/pull/2315) | fix(deps): scope base-compose service discovery to the services block | lint failed after conflict union |
| [#2371](https://github.com/Osmantic/ODS/pull/2371) | fix(privacy): fail closed on key persistence errors | conflict markers left unresolved |
| [#2448](https://github.com/Osmantic/ODS/pull/2448) | fix(sessions): write pruned sessions state JSON atomically in session-cleanup.sh | lint failed after conflict union |
| [#2489](https://github.com/Osmantic/ODS/pull/2489) | fix(setup): guard rm -rf against unvalidated install dir | lint failed after conflict union |
| [#2547](https://github.com/Osmantic/ODS/pull/2547) | fix(dashboard-api): specify utf-8 encoding and ignore comments in _read_installed_version in main.py | conflict markers left unresolved |
| [#2644](https://github.com/Osmantic/ODS/pull/2644) | fix(backup): recognize multi-segment user-named backup IDs | conflict markers left unresolved |

## Not yet processed — pre-v2.6.0 (125)

Excluded by the version gate (branch predates the DreamServer→ODS rename).
Not evaluated for mergeability; re-run the candidate filter against these once
they're rebased or superseded upstream.

| Upstream PR | Title |
|---|---|
| [#1584](https://github.com/Osmantic/ODS/pull/1584) | fix(dashboard-api): guard async HTTP client creation with asyncio.Lock |
| [#1586](https://github.com/Osmantic/ODS/pull/1586) | fix(dashboard-api): check is_symlink() before is_file() in dir_size_gb |
| [#1611](https://github.com/Osmantic/ODS/pull/1611) | fix(installer): skip Qdrant on 64K-page arm64 hosts |
| [#1613](https://github.com/Osmantic/ODS/pull/1613) | fix(dashboard): route LAN and extension links to usable UI surfaces |
| [#1647](https://github.com/Osmantic/ODS/pull/1647) | fix(hermes): modernize hotfix #1497 import hook to find_spec (PEP 451… |
| [#1708](https://github.com/Osmantic/ODS/pull/1708) | fix(rootless): auto-fix data-directory ownership for Docker rootless mode  |
| [#1732](https://github.com/Osmantic/ODS/pull/1732) | fix(release-gate): report missing files instead of crashing version check |
| [#1737](https://github.com/Osmantic/ODS/pull/1737) | fix(tests,cli,docs): resolve dashboard-api Bearer auth across the stack |
| [#1755](https://github.com/Osmantic/ODS/pull/1755) | fix(rollback): resolve layered compose stack in ods-update.sh + ods-restore.sh |
| [#1787](https://github.com/Osmantic/ODS/pull/1787) | fix(amd): make hipfire's model dashboard-controlled and clobber-proof |
| [#1792](https://github.com/Osmantic/ODS/pull/1792) | fix(ci): restrict AI issue triage to label-only mutations |
| [#1809](https://github.com/Osmantic/ODS/pull/1809) | fix(dashboard-api): don't crash vision stream on empty/null choices |
| [#1930](https://github.com/Osmantic/ODS/pull/1930) | fix(search-probe): distinguish upstream engine throttling from Dream Server failures (#1342) |
| [#1933](https://github.com/Osmantic/ODS/pull/1933) | fix(model-router): bound SSE rewriter holdback buffer |
| [#1944](https://github.com/Osmantic/ODS/pull/1944) | fix(render-configs): replace runtime configs atomically |
| [#1945](https://github.com/Osmantic/ODS/pull/1945) | fix(resolver): restore user-extension compose guard parity with the API |
| [#1946](https://github.com/Osmantic/ODS/pull/1946) | fix(stability): replace Hermes config and session writes atomically |
| [#1948](https://github.com/Osmantic/ODS/pull/1948) | fix(security): write generated API key files atomically |
| [#1949](https://github.com/Osmantic/ODS/pull/1949) | fix(migration): write migration state and environment updates atomically |
| [#1953](https://github.com/Osmantic/ODS/pull/1953) | fix(stability): write extensions catalog and SOUL.md context atomically |
| [#1954](https://github.com/Osmantic/ODS/pull/1954) | fix(stability): write preflight report atomically |
| [#1956](https://github.com/Osmantic/ODS/pull/1956) | fix(dashboard-api): write persona, setup progress, and compose configs atomically |
| [#1963](https://github.com/Osmantic/ODS/pull/1963) | fix(token-spy): stop logging upstream error bodies on streaming requests |
| [#1969](https://github.com/Osmantic/ODS/pull/1969) | fix(host-agent): write PID files atomically in ods-host-agent.py |
| [#1970](https://github.com/Osmantic/ODS/pull/1970) | fix(windows): write OpenCode config objects atomically in opencode-co… |
| [#1975](https://github.com/Osmantic/ODS/pull/1975) | fix(windows): write configuration files atomically in env-generator.ps1 |
| [#1976](https://github.com/Osmantic/ODS/pull/1976) | fix(hermes): support basic auth in hermes_bridge and compose for post-hardening auth gate (#1964) |
| [#2005](https://github.com/Osmantic/ODS/pull/2005) | fix(models): guard null port and type errors in model router sync helpers |
| [#2006](https://github.com/Osmantic/ODS/pull/2006) | fix(backends): add Intel Arc backend contract |
| [#2007](https://github.com/Osmantic/ODS/pull/2007) | fix(dashboard-api): guard null metric values in service resources calculation |
| [#2008](https://github.com/Osmantic/ODS/pull/2008) | fix(dashboard-api): support dictionary objects in Token Spy service lookup |
| [#2009](https://github.com/Osmantic/ODS/pull/2009) | fix(windows): strip matched quote pairs when parsing env values in generator |
| [#2010](https://github.com/Osmantic/ODS/pull/2010) | fix(host-agent): strip only matched quote pairs when loading env file |
| [#2015](https://github.com/Osmantic/ODS/pull/2015) | fix(mdns): strip only matched quote pairs when reading env file |
| [#2017](https://github.com/Osmantic/ODS/pull/2017) | fix(config): strip matched quote pairs and allow leading whitespace in env file reader |
| [#2018](https://github.com/Osmantic/ODS/pull/2018) | fix(dashboard-api): guard null nodes payload in cluster status refresh |
| [#2022](https://github.com/Osmantic/ODS/pull/2022) | fix(oracle): strip matched quote pairs and allow leading whitespace in env reader |
| [#2024](https://github.com/Osmantic/ODS/pull/2024) | fix(session-signer): validate integer expiry before computing hmac signature |
| [#2026](https://github.com/Osmantic/ODS/pull/2026) | fix(features): support dictionary objects in calculate_feature_status |
| [#2027](https://github.com/Osmantic/ODS/pull/2027) | fix(lemonade): strip matched quote pairs when normalizing base url |
| [#2028](https://github.com/Osmantic/ODS/pull/2028) | fix(security): strip matched quote pairs and whitespace in dashboard api key initialization |
| [#2030](https://github.com/Osmantic/ODS/pull/2030) | fix(host-agent-client): guard unicode decode and non-text errors in error detail extraction |
| [#2031](https://github.com/Osmantic/ODS/pull/2031) | fix(helpers): handle non-file paths and unicode errors safely in read json file |
| [#2032](https://github.com/Osmantic/ODS/pull/2032) | fix(helpers): validate finite float values in prometheus metrics parser |
| [#2037](https://github.com/Osmantic/ODS/pull/2037) | fix(agents): guard null last_update timestamp in agent metrics html endpoint |
| [#2038](https://github.com/Osmantic/ODS/pull/2038) | fix(updates): strip matched quote pairs and allow leading whitespace in version reader |
| [#2040](https://github.com/Osmantic/ODS/pull/2040) | fix(templates): cleanup visiting set on dependency ordering exception |
| [#2041](https://github.com/Osmantic/ODS/pull/2041) | fix(resources): handle permission and os errors safely during data directory scanning |
| [#2042](https://github.com/Osmantic/ODS/pull/2042) | fix(setup): handle directory paths and unicode errors safely in persona prompt reader |
| [#2043](https://github.com/Osmantic/ODS/pull/2043) | fix(tailscale): fall back to offline payload when host agent is unreachable |
| [#2044](https://github.com/Osmantic/ODS/pull/2044) | fix(voice): handle dictionary or missing status gracefully in voice health check |
| [#2045](https://github.com/Osmantic/ODS/pull/2045) | fix(privacy): handle invalid non-integer port values safely in privacy shield endpoints |
| [#2049](https://github.com/Osmantic/ODS/pull/2049) | fix(model-state): handle unicode decoding errors safely when reading state schema and file |
| [#2050](https://github.com/Osmantic/ODS/pull/2050) | fix(auth): strip matched quote pairs when reading cookie domain environment variable |
| [#2051](https://github.com/Osmantic/ODS/pull/2051) | fix(gpu): strip matched quote pairs when reading environment variables in gpu router |
| [#2052](https://github.com/Osmantic/ODS/pull/2052) | fix(model-routes): strip matched quote pairs when reading internal router key |
| [#2053](https://github.com/Osmantic/ODS/pull/2053) | fix(features): strip matched quote pairs when parsing HOST_RAM_GB |
| [#2054](https://github.com/Osmantic/ODS/pull/2054) | fix(talk): strip matched quote pairs from vision model name |
| [#2055](https://github.com/Osmantic/ODS/pull/2055) | fix(workflows): handle directory paths and unicode errors safely in workflow catalog reader |
| [#2078](https://github.com/Osmantic/ODS/pull/2078) | fix(resources): handle permission and os errors safely during data directory scanning |
| [#2079](https://github.com/Osmantic/ODS/pull/2079) | fix(features): handle missing or non-dictionary requirements safely in feature calculator |
| [#2081](https://github.com/Osmantic/ODS/pull/2081) | fix(user-extensions): handle non-string and non-dict manifest values safely during service scan |
| [#2082](https://github.com/Osmantic/ODS/pull/2082) | fix(tailscale): validate host agent response shape in proxy helper |
| [#2083](https://github.com/Osmantic/ODS/pull/2083) | fix(privacy-shield): safely parse SHIELD_PORT environment variable with quote stripping and default fallback |
| [#2084](https://github.com/Osmantic/ODS/pull/2084) | fix(talk): ensure active model compatibility is a dictionary before item assignment |
| [#2087](https://github.com/Osmantic/ODS/pull/2087) | fix(token-spy): price on the longest matching model prefix |
| [#2090](https://github.com/Osmantic/ODS/pull/2090) | fix(gpu): stop hybrid splits stranding a GPU on odd counts |
| [#2092](https://github.com/Osmantic/ODS/pull/2092) | fix(settings): apply SearXNG config to the SearXNG container |
| [#2093](https://github.com/Osmantic/ODS/pull/2093) | fix(settings): recreate litellm for the keys only litellm reads |
| [#2095](https://github.com/Osmantic/ODS/pull/2095) | fix(updates): order pre-releases below the release they precede |
| [#2096](https://github.com/Osmantic/ODS/pull/2096) | fix(token-spy): stop the skills block inflating the file above it |
| [#2097](https://github.com/Osmantic/ODS/pull/2097) | fix(model-router): hold non-streamed evidence to the streaming bar |
| [#2099](https://github.com/Osmantic/ODS/pull/2099) | fix(token-spy): store the MEMORY.md prompt bucket on SQLite |
| [#2101](https://github.com/Osmantic/ODS/pull/2101) | fix(installer): normalize the install dir on hosts without GNU realpath |
| [#2102](https://github.com/Osmantic/ODS/pull/2102) | fix(installer): stop the readiness summary flagging healthy containers |
| [#2103](https://github.com/Osmantic/ODS/pull/2103) | fix(ape): let a served circuit-breaker cooldown actually reopen the gate |
| [#2104](https://github.com/Osmantic/ODS/pull/2104) | fix(ape): stop the per-minute limiter retaining every session id |
| [#2105](https://github.com/Osmantic/ODS/pull/2105) | fix(ape): make path_guard deny a destination it cannot read |
| [#2106](https://github.com/Osmantic/ODS/pull/2106) | fix(support-bundle): redact collected files with the same secret set as .env |
| [#2107](https://github.com/Osmantic/ODS/pull/2107) | fix(token-spy): count MEMORY.md as its own workspace section |
| [#2108](https://github.com/Osmantic/ODS/pull/2108) | fix(updates): stop caching GitHub error bodies as a release lookup |
| [#2109](https://github.com/Osmantic/ODS/pull/2109) | fix(installer): close the redaction gaps in the compose failure report |
| [#2110](https://github.com/Osmantic/ODS/pull/2110) | fix(dashboard-api): report non-JSON Token Spy responses as content-type warnings |
| [#2112](https://github.com/Osmantic/ODS/pull/2112) | fix(nvidia-topo): rank every NVLink connection above PCIe |
| [#2114](https://github.com/Osmantic/ODS/pull/2114) | fix(dashboard-api): match installed n8n workflows the same way everywhere |
| [#2115](https://github.com/Osmantic/ODS/pull/2115) | fix(dashboard-api): stop templates rejecting extensions with no declared GPU backends |
| [#2116](https://github.com/Osmantic/ODS/pull/2116) | fix(deps): resolve image ARGs the way the builder does |
| [#2117](https://github.com/Osmantic/ODS/pull/2117) | fix(dashboard-api): keep a malformed GGUF file_type inside the degrade contract |
| [#2122](https://github.com/Osmantic/ODS/pull/2122) | fix(dashboard-api): bound model picks to the usable share of unified memory |
| [#2123](https://github.com/Osmantic/ODS/pull/2123) | fix(installer): stop the selector allowlist dropping catalog runtime tuning |
| [#2125](https://github.com/Osmantic/ODS/pull/2125) | fix(dashboard-api): keep coder-next out of unified-memory recommendations |
| [#2130](https://github.com/Osmantic/ODS/pull/2130) | fix(macos): honour LLAMA_PARALLEL on native llama-server launches |
| [#2131](https://github.com/Osmantic/ODS/pull/2131) | fix(macos): honour the long-context llama.cpp tunables on native launches |
| [#2139](https://github.com/Osmantic/ODS/pull/2139) | fix(dashboard-api): bound array length and metadata count during GGUF inspection |
| [#2141](https://github.com/Osmantic/ODS/pull/2141) | fix(dashboard-api): bound model context size to positive integers in model info helper |
| [#2151](https://github.com/Osmantic/ODS/pull/2151) | fix(performance-oracle): handle unicode decoding errors safely when reading env file |
| [#2152](https://github.com/Osmantic/ODS/pull/2152) | fix(config): specify utf-8 encoding when reading extension manifest files |
| [#2155](https://github.com/Osmantic/ODS/pull/2155) | fix(models): parse float timeout environment variables safely with fallback defaults |
| [#2175](https://github.com/Osmantic/ODS/pull/2175) | fix(python): find the real interpreter when Windows Store aliases shadow PATH |
| [#2183](https://github.com/Osmantic/ODS/pull/2183) | fix(cli): complete every command and service ods-cli resolves |
| [#2186](https://github.com/Osmantic/ODS/pull/2186) | fix(dashboard): report bootstrap download size in GiB |
| [#2187](https://github.com/Osmantic/ODS/pull/2187) | fix(workflows): resolve dependency aliases before health-checking |
| [#2189](https://github.com/Osmantic/ODS/pull/2189) | fix(linux): honour OPENCODE_PORT in the OpenCode systemd unit |
| [#2190](https://github.com/Osmantic/ODS/pull/2190) | fix(backup): capture the data of every bundled service |
| [#2191](https://github.com/Osmantic/ODS/pull/2191) | fix(audit): check the feature display fields the dashboard renders |
| [#2195](https://github.com/Osmantic/ODS/pull/2195) | fix(privacy-shield): scrub card numbers that are not 16 digits |
| [#2197](https://github.com/Osmantic/ODS/pull/2197) | fix(env): declare every key the compose stack interpolates |
| [#2202](https://github.com/Osmantic/ODS/pull/2202) | fix(backup): load the shared rsync helper from the script, not the target |
| [#2205](https://github.com/Osmantic/ODS/pull/2205) | fix(remote-provider): bracket IPv6 targets in the SSH forward spec |
| [#2213](https://github.com/Osmantic/ODS/pull/2213) | fix(security): write dashboard API key atomically with restricted permissions |
| [#2214](https://github.com/Osmantic/ODS/pull/2214) | fix(docs): validate all root markdown links |
| [#2215](https://github.com/Osmantic/ODS/pull/2215) | fix(token-spy): write token spy API key atomically with restricted permissions |
| [#2216](https://github.com/Osmantic/ODS/pull/2216) | fix(hermes): replace Hermes config atomically in patch-hermes-config.py |
| [#2217](https://github.com/Osmantic/ODS/pull/2217) | fix(catalog): write extensions catalog atomically in generate-extensions-catalog.py |
| [#2218](https://github.com/Osmantic/ODS/pull/2218) | fix(install-context): write installation context atomically in build-installation-context.py |
| [#2225](https://github.com/Osmantic/ODS/pull/2225) | fix(preflight): write preflight report atomically in preflight-engine.sh |
| [#2226](https://github.com/Osmantic/ODS/pull/2226) | fix(doctor): write doctor report atomically in ods-doctor.sh |
| [#2228](https://github.com/Osmantic/ODS/pull/2228) | fix(simulation): write simulation summary and evidence atomically in simulate-installers.sh |
| [#2229](https://github.com/Osmantic/ODS/pull/2229) | fix(capability): write capability profile JSON atomically in build-capability-profile.sh |
| [#2233](https://github.com/Osmantic/ODS/pull/2233) | fix(support-bundle): write bundle manifest JSON atomically in ods-support-bundle.sh |
| [#2234](https://github.com/Osmantic/ODS/pull/2234) | fix(dashboard-api): write extension install progress atomically in extensions.py |
| [#2236](https://github.com/Osmantic/ODS/pull/2236) | fix(dashboard-api): pre-apply restricted permissions on magic-link token store temp file |
| [#2251](https://github.com/Osmantic/ODS/pull/2251) | fix(privacy-shield): add missing await on upstream.read() call |
| [#2648](https://github.com/Osmantic/ODS/pull/2648) | fix(installer): make Windows enable/disable use bash correctly |
| [#2649](https://github.com/Osmantic/ODS/pull/2649) | fix(cli): mask secrets in Windows config show output |

## Anything not listed above

Has not been evaluated by this process at all — either it's a `feat(...)`/
`test(...)`/`docs(...)`/`ci(...)`/`refactor(...)` PR (out of scope for this pass,
which only covered `fix(...)`), or it was opened after this batch ran. Re-run the
candidate filter (see step 1 above) against the current PR list to find it.
