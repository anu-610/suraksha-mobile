# SOS reliability review — 2 November 2026

## Source of truth

This branch builds on `codex/sos-live-updates-20261101` at mobile `161d17acbcb2524e5c43f559b5e9cad2a50a33a6` and backend `1f27687a7c9ba7a07bb96ee425df795cb291d562`. Those branches contain substantial SOS work not yet merged into master. No existing functionality or unrelated user changes were removed. Use the matching backend branch with this mobile version.

The Expo 57 / React Native 0.86 app uses a custom Kotlin BLE module. A connected-device foreground service owns scanning, GATT reads and rotating advertisements; a persisted native inbox wakes Headless JS. JS verifies P-256 origin proofs, persists relay packets, enforces expiry/hops, forwards to authenticated FastAPI endpoints and relays signed receipts. Active sender events and cancellation packets persist separately. Expo Location supplies foreground and opt-in background fixes. PostgreSQL/PostGIS stores incidents; cancellation records prevent reactivation; an outbox supports Redis/WebGIS fanout. SecureStore holds account/device credentials. Backend address settings validate and pin the authority before switching.

## Findings and changes

| Finding | Root cause | Change |
|---|---|---|
| GPS timeout left provider work running | Promise.race stopped waiting but did not stop the native one-shot request | Use a removable location watch, including late registration cleanup; bound last-known fallback |
| Last coordinates disappeared on failed refresh | Sender and nearby display unconditionally replaced location with null or older fixes | Preserve capture time and latest usable fix; reject older/unknown-time replacements and worse accuracy at equal capture time |
| Backend accepted unknown or worse same-time coordinates over known fixes | Update predicate accepted missing timestamps and every equal timestamp | Match the timestamp/accuracy ordering policy while allowing genuinely newer fixes |
| Relay duplicates could consume the remaining hop budget | Equal revisions/timestamps replaced a shorter route with a longer one | Retain the shorter route; skip identical durable queue rewrites |
| Repeated advertisements could disturb fair rotation | Equal-priority changed packet bytes preempted the current slot, including new relay metadata | Only urgent packets or updates to the currently selected incident preempt; periodic retry still restores radio queues |
| Local cancellation could fail with expired device credentials | Signing was mandatory before persisting cancellation | Persist an unsigned terminal draft if signing fails, retire local alert advertising, retry signing and use authenticated HTTP cancellation on reconnection; never transmit the unsigned draft |
| Slow token refresh caused request cancellation | SOS HTTP timeout started before refreshing credentials; cached compatibility token could shadow account refresh | Separate budgets, prefer account credentials, retry an HTTP 401 once with refreshed credentials |
| Logout could race a refresh | Local session invalidation followed awaited network revocation | Clear local session before network revocation |
| Duplicate tracking starts / cancellation race | Start and stop operations could overlap | Serialize lifecycle and avoid duplicate native location tasks |
| Backend WebSocket crashed on first receive | `time.time()` used without importing time | Restore import and cover connected/disconnected lifecycle |

The historical HTTP 422 and “fetch request has been cancelled” reports do not include a failing device trace/payload. Their exact historical cause is therefore not established. Current HTTP tests exercise signed protocol-3 payloads with and without GPS, three relay hops, duplicate alerts/cancellations and late-alert rejection. Wrong coordinate field names (`latitude`/`longitude` instead of wire `lat`/`lng`) are explicitly rejected with a field-specific 422; existing mobile mapping is correct. Timeout handling preserves queues and reports a useful retry message rather than suppressing errors.

## Validation

Baseline: 43 mobile tests, typecheck and lint passed; backend 47 passed / 2 skipped locally.
After fixes: 52 mobile tests, typecheck and lint passed; backend 51 passed / 2 skipped locally. The skipped tests require disposable PostGIS and Redis services; the existing backend GitHub Actions workflow supplies them and applies migrations.

Added native JVM tests cover shorter-path retention and advertisement preemption. The APK workflow runs these before assembly, embeds JS (no Metro dependency), and includes SOURCE_COMMIT.txt and SHA256SUMS.txt. Its artifact name includes the source commit. Consult the corresponding workflow run for the final build result; a passing JS suite alone is not an APK build result.

Automated simulated A→B→C→D coverage includes two offline incidents, no intermediate HTTP uploads, delayed connectivity at D, cancellation first, late-alert suppression and idempotent uploads. Existing tests cover signed receipt round trips, signature tampering, storage races, GPS/BLE blocking and helper consent. These tests mock radios and do not prove physical BLE operation.

Physical four-phone, installation, launch, permission prompts, range, locked-screen, minimized-app and Bluetooth-toggle tests have NOT been performed in this environment. Follow RELAY_TESTING.md on four phones; isolate radio ranges so A cannot skip B/C. Use the same new APK on all devices. Production rollout remains gated on those results.

## Setup and release

1. Backend: preserve `.env` and device CA; install requirements; run `alembic upgrade head` (through migration 008); start the existing server as documented in README.md. This change adds no new schema migration. Existing master deployments still need inherited migrations 007 and 008.
2. Mobile: `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`. Build through Local test APK workflow on this branch. The package is `com.suraksha.emergency.localtest`, versionCode 7, arm64-v8a. It is a debug-key-signed **test APK**, not a production/store release.
3. Configure the reachable backend origin in Settings. The workflow retains the previous local-development default; change it for your network. Local HTTP is test-only; production requires HTTPS. Sign into individual accounts and enroll each device while online before offline testing.
4. Enable nearby relay and allow required permissions. Enable background location from the foreground SOS prompt. Cancellation is immediate locally; server confirmation is a separate delivery state.

## Limits

- Android schedules background work; exact 60-second delivery is not guaranteed. No unrestricted operation after force-stop is claimed. Relay must be opted in; background location requires permission.
- Device certificates must remain valid for verified offline forwarding. An expired certificate cannot authenticate a BLE cancellation; local cancellation and eventual authenticated HTTP recovery still work.
- SOS packets expire after their TTL; extended partitions can exceed it. Offline cancellation drafts remain queued for owner HTTP synchronization.
- Public-key trust and user roles are preserved. Existing refresh sessions are revocable; already-issued access JWTs retain their short lifetime.
- `E-Kip19/suraksha-webgis` returned 404/authentication failure for the connected account. Its current implementation could not be audited. Backend WebSocket/outbox integration was preserved, but end-to-end WebGIS behavior is unverified.

## BLE relay upload fix — 3 November 2026

Problem: a phone could receive an SOS over BLE, but the relayed copy often never reached the server.

| Finding | Root cause | Change |
|---|---|---|
| Relayed SOS never uploaded on slow or local-only Wi-Fi | A 1.5 s `/health` probe gated every upload; on Wi-Fi without public internet or a slow link it failed, so no upload was even tried | Only the network interface state gates uploads. The real API request and the durable retry/backoff decide success |
| One bad inbox packet blocked queued uploads | `processMeshWork` awaited inbox processing first and threw before forwarding ran; one failing packet also stopped every packet after it | Each inbox packet is processed on its own (failures stay in the native inbox for the next tick); upload and retry run even when the inbox step fails, then the error is reported |
| Upload accepted but retried forever | A server receipt that could not be verified/stored (e.g. CA key not saved yet) threw after a successful upload, so it was never marked forwarded and the loop skipped later packets | Receipt problems are logged and the upload is still completed; the sender falls back to a local "accepted" delivery state |
| Phone deaf after a quick Bluetooth off/on | Android drops the scan and GATT server without callbacks; `scanning`/`advertising` stayed true until the 15 s tick happened to see Bluetooth off | Listen to `ACTION_STATE_CHANGED`; reset radio state on off and restart scan/adverts on on, keeping the packet queue |
| Scan silently dead after app switching | Every foreground/background change restarted the scan; more than 5 starts in 30 s makes Android ignore the scan (older versions give no error) | Restart is debounced 3 s and scan starts are rate-limited to 4 per 30 s (pending start is scheduled, not dropped) |
| Long scans stop returning results on some phones | Android can downgrade a scan running ~30 min to opportunistic | The service tick refreshes a scan older than 20 min |
| Peer read from us fails while both phones read each other | The GATT server reset its per-phone cursor only on link disconnect; the shared LE link outlived the reader's connection, so the next read hit a finished/mid-way cursor. Closing our client also dropped the link mid-way through the peer's read, and equal 3 s cooldowns repeated the collision | Server restarts a transfer after a 2 s read gap and clears it after the last frame; client waits (max 10 s) for the peer's read before closing; random 0–2 s extra cooldown |
| Crash loop of relay service | Android 14+ throws from `startForeground` for a connectedDevice service without Bluetooth permission (e.g. after a sticky restart); Android 12+ throws when starting it from background | Both are caught; the service stops cleanly and in-app scanning keeps running |

Validation: 56 mobile tests pass (5 new, all failing on the old code), typecheck and lint pass, 7 `PacketPolicy` JVM tests pass. The full native module was not compiled locally (no Android SDK); the CI `android-native` job does that. Physical phone-to-phone BLE has NOT been tested; follow RELAY_TESTING.md.
