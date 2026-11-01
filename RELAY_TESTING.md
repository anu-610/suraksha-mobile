# SOS delivery and consent testing (protocol 3)

Update the backend first and run `python -m alembic upgrade head` (through migration
008). Keep the existing `.env`, device certificate authority, database and account
data. Install the matching APK on **every test phone**. This build still reads
legacy signed alerts, but older APKs cannot relay the new protocol 3 messages.

Set each app's backend address to the computer's reachable Wi-Fi IPv4 address and
port 8000. Sign in and enroll each device while online. Enable Bluetooth, location,
notifications and nearby relay. A successful APK build is not evidence of radio
range or delivery between physical phones.

## What to expect

- SOS is saved immediately with a recent cached fix, or no coordinates. Bluetooth,
  HTTP upload and fresh GPS acquisition run independently. A fresh fix becomes a
  signed update of the same SOS ID; later updates are attempted about every minute.
- Delivery status distinguishes saved locally, received by another phone, accepted
  by the server, and cancellation confirmed. BLE advertising alone is never a
  receipt. Server receipts are signed by the enrolled backend authority and can
  return through offline relay phones. A server receipt does not mean a responder
  has been dispatched.
- Cancellation is durable before the button completes. It has radio priority and
  does not wait for GPS, HTTP or Bluetooth startup. Late alert revisions cannot
  replace a cancellation. A native radio failure retains accepted queued packets.
- GPS capture time and accuracy are displayed independently of alert updates.
  Missing/old fixes are shown as last known; legacy fixes have unknown capture time.
- A helper request has its own ID and five-minute expiry. Repeating it creates a new
  request and notification, including after dismissal. Declining sends a reply
  without GPS or internet. Sharing requires explicit consent, backend reachability
  and a fresh fix. The helper can withdraw permission, including while GPS is being
  acquired. The sender can withdraw the request. Expired/withdrawn replies hide
  coordinates and map actions. Cancellation invalidates pending consent work.
- Helper snapshots remain readable by nearby mesh devices, as disclosed in the
  consent dialog. Withdrawal must propagate; it cannot erase what another person
  already saw. Regular relay packets do not attach the relay's own coordinates.
- Duplicate uploads are idempotent. Rate-limited uploads respect Retry-After;
  cancellations are not blocked by an unrelated alert upload's rate-limit cooldown.
  At the hop limit, a receiver may upload to the server but cannot forward by BLE.

## Physical acceptance tests

1. **First dispatch:** disable GPS outdoors/indoors, send an SOS, and measure from
   the button press. The first packet must not wait for the GPS timeout. Restore
   GPS and check the same SOS ID gains coordinates with their capture time.
2. **Actual multiple hops:** A and B offline, C online. Place A and C outside each
   other's Bluetooth range, with B able to reach both. Verify C uploads A's SOS,
   then allow the signed server receipt to travel C → B → A. Keep all radios on.
3. **Offline cancel:** cancel on A while a GPS fix or radio restart is pending.
   The local cancel button should finish promptly. B/C remove the alert, C uploads
   the cancellation, and A eventually shows server confirmation. Repeat with a
   cancellation arriving before its alert and after restarting B.
4. **Consent:** request on A; decline on C, then make a new request and agree on C.
   Check replies return through B and C's location appears only after acceptance.
   Withdraw on C and confirm the map disappears on A. Repeat cancellation/request
   withdrawal while C is acquiring GPS; no snapshot may be sent afterwards.
5. **Freshness:** obtain GPS, then deny/disable it. Updates must not make the last
   usable backend coordinates look newly captured. Check age and accuracy labels.
6. **Recovery:** toggle Bluetooth off/on, interrupt the backend, and restart relay
   phones. Queue state must survive; no cancelled SOS or withdrawn offer returns.
7. **Background:** enable background SOS updates, then test Home, screen lock and
   swiping Recents separately. Record Android version, model, timings and whether
   the foreground notification remains. Stop relay explicitly and check it stops
   scanning. Dismissing a card must not cancel someone else's SOS.

TTL and hop limits bound propagation; messages do not jump indefinitely. An active
SOS with no refresh for an hour expires locally. Android/OEM restrictions, force
stop, powered-off Bluetooth, missing permissions and process termination can stop
work. Reopen after force stop/reboot. These tests do not guarantee an uninterrupted
emergency channel. iOS needs its own device/build validation.

## Automated checks

`npm test`, `npm run typecheck`, and `npm run lint` cover signatures, receipts,
concurrent cancellation, delayed GPS/radio operations, helper consent changes,
retry policy, hop limits and existing account/settings flows. The APK workflow also
runs native PacketPolicy JVM tests before building the Android app. Boundary mocks
exercise protocol behavior; they do not simulate physical BLE or OS scheduling.

If HTTP 422 recurs, record the endpoint, SOS ID/revision and the validation field
message displayed by the app. The old reported incident has no captured response
body, so it is not attributed to a particular cause. Do not include credentials.
