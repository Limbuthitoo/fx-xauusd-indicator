# Mobile Device Validation

Use this checklist for the signed production Android APK. Run it on a physical arm64 Android device because notification delivery, lock-screen behavior, biometric authentication, and background reconnects cannot be validated in a browser or simulator.

## Release Gate

From the repository root:

```bash
npm run verify:mobile-release
npm run typecheck -w @orb-guide/mobile
npm run typecheck -w @orb-guide/api
```

Record the APK filename, SHA-256 checksum, package name, version name, version code, device model, Android version, and test date.

## Install And Sign In

1. Enable USB debugging and connect the phone.
2. Confirm the device is authorized with `adb devices -l`.
3. Install the release with `adb install -r <apk-path>`.
4. Launch XAUUSD Signal and sign in with a tenant assigned to Module 1 ORB.
5. Verify biometric unlock, logout, and sign-in recovery.

Pass when the app starts without a crash, shows the production tenant, and restores an authenticated session correctly.

## Push Registration

1. Open Account and select **Register Push Alerts**.
2. Allow Android notifications.
3. Confirm the device count and last-sync time update.
4. Select **Send Test Push**.
5. Put the app in the background and lock the phone.

Pass when the test notification appears on the lock screen, uses the trading alert channel, sounds/vibrates according to Android settings, and opens the app when tapped.

## BUY And SELL Signal Delivery

Set an authenticated tenant token without writing it to the repository:

```bash
export TENANT_TOKEN='<tenant-jwt>'
export API_BASE_URL='https://fx.bijaysubbalimbu.com.np'
```

Send a QA BUY signal:

```bash
curl --fail-with-body -X POST "$API_BASE_URL/api/dev/test-signal" \
  -H "Authorization: Bearer $TENANT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"direction":"LONG"}'
```

Send a QA SELL signal:

```bash
curl --fail-with-body -X POST "$API_BASE_URL/api/dev/test-signal" \
  -H "Authorization: Bearer $TENANT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"direction":"SHORT"}'
```

These endpoints create marked QA candidates and notifications only. They bypass strategy rules and report `externalOrdersPlaced: 0`.

For each direction, verify:

1. The lock-screen alert clearly says QA BUY or QA SELL.
2. Tapping the notification opens the relevant signal context.
3. Signal Desk shows the correct side, symbol, entry, stop, target, RR, grade, and QA warning.
4. BUY uses a stop below entry and target above entry; SELL uses the reverse geometry.
5. The notification is visible and can be acknowledged in Alerts.

Clear QA setup candidates after validation:

```bash
curl --fail-with-body -X POST "$API_BASE_URL/api/dev/test-signal/clear" \
  -H "Authorization: Bearer $TENANT_TOKEN"
```

## Live Chart And Resilience

1. Open Live Chart and switch between 30, 60, and 90 candles.
2. Drag across candles and verify crosshair/OHLC values track the selected candle.
3. Confirm entry, stop, target, and strategy levels align with Signal Desk.
4. Keep the chart open until a websocket candle update arrives; confirm the layout does not jump.
5. Disable connectivity for 30 seconds, then restore it.
6. Background the app for two minutes, reopen it, and refresh.

Pass when stale/offline state is visible, reconnect succeeds without duplicate candles, and the latest candle timestamp advances after the feed resumes.

## Final Evidence

Capture screenshots of Home, BUY, SELL, Live Chart, lock-screen alert, and notification settings. Record every failed step with its device log from:

```bash
adb logcat -d | rg 'AndroidRuntime|FATAL EXCEPTION|XAUUSD|ExpoNotification'
```

Do not approve release distribution until BUY and SELL delivery, notification tap behavior, chart reconnect, and biometric/session recovery all pass on at least one supported physical device.
