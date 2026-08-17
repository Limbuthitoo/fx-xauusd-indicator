# XAUUSD Signal Mobile

React Native + Expo tenant companion app for the trading dashboard.

## Features

- Tenant login with the existing API credentials.
- Assigned strategy modules only.
- Signal Desk with separate BUY and SELL views, confidence, grade, and setup evidence.
- Professional XAUUSD candlestick chart with 30/60/90-candle ranges, OHLC inspection, crosshair, and strategy levels.
- Current module signal status with entry range, stop loss, targets, reward-to-risk, and invalidation context.
- Active/latest paper trade status.
- Weekly and monthly win-rate summary.
- Recent notification inbox.
- High-priority Firebase/Expo push alerts on the dedicated Android `trading-alerts` channel.

The mobile chart does not call Twelve Data. It uses the backend API for initial load and `/api/live/ws` websocket events for live candle updates. Strategy levels, paper entries, SL, and TP still come from the backend, which uses the shared PostgreSQL/cache feed already maintained by the server.

## Alerts

The API stores Expo push tokens in PostgreSQL and sends push alerts when automation creates tenant notifications through the live market-data path:

- NY pre-session warning.
- Valid Module 1 or Module 2 setup alert.
- Paper trade opened.
- Paper trade closed by TP, SL, or session close.

## Push Notification Flow

1. The tenant signs in on the mobile app.
2. The app asks Android/iOS for notification permission.
3. The app requests an Expo token and, on Android standalone/dev builds, a native Firebase device token.
4. The app sends available tokens to `POST /api/mobile/push-token`.
5. The API stores tokens in PostgreSQL in `mobile_push_tokens`.
6. When an automated module creates a valid tenant notification, the API sends through Firebase Cloud Messaging when configured. Expo Push Service remains a fallback for Expo Go/local testing.

Push notifications need a real device and an EAS/Expo project identity. Expo Go is useful for early testing, but the real APK should be built with EAS so the app has its own package identity and push credentials.

## Firebase VPS Setup

For VPS production, set `PUSH_PROVIDER=firebase` and configure one Firebase Admin credential method on the API server:

```bash
FIREBASE_PROJECT_ID=your-firebase-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Alternatively, place the service account JSON outside the repo and set:

```bash
FIREBASE_SERVICE_ACCOUNT_PATH=/secure/path/firebase-service-account.json
```

Do not commit Firebase service account JSON files. The repo ignores common service-account filenames.

## Local Run

Set the mobile API URL to the machine running the API.

For iOS simulator, `http://localhost:7073` usually works.

For a physical phone, use the Mac LAN address, for example:

```bash
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.100:7073 npm run dev:mobile
```

Expo push notifications require a real device. Simulators can use the app, but push-token registration will show that a real device is required.

## Android APK Build

Installable Android APK builds use `apps/mobile/eas.json`.

First-time setup:

```bash
cd apps/mobile
npx eas-cli login
npx eas-cli init
```

When EAS asks about push notifications, enable them. For Android standalone builds, configure Firebase Cloud Messaging credentials in EAS so push tokens work outside Expo Go.

Build an APK you can install directly on your Android phone:

```bash
cd apps/mobile
npx eas-cli build -p android --profile preview-apk
```

Set the APK API URL per build with `EXPO_PUBLIC_API_BASE_URL`. The `preview-apk` profile currently contains a LAN placeholder:

```json
"EXPO_PUBLIC_API_BASE_URL": "http://192.168.1.100:7073"
```

Replace it with your Mac/server IP before building, or override it from EAS environment variables.

After the VPS is live, build an installable APK pointed at the production domain:

```bash
cd apps/mobile
npx eas-cli build -p android --profile production-apk
```

After installing the APK:

1. Log in with the tenant account.
2. Open Account.
3. Tap Register Push Alerts.
4. Confirm Permission, Backend Devices, Last Sync, and Expo token.
5. Tap Send Test Push.
6. Confirm the Android notification arrives and the latest alert appears in Alerts.

For complete BUY/SELL notification, deep-link, chart, reconnect, and background checks, use the [mobile device validation runbook](../../docs/mobile-device-validation.md).

Before distributing a release, verify its source configuration:

```bash
npm run verify:mobile-release
```

Production Play Store builds should use the `production` profile, which creates an `.aab` app bundle:

```bash
cd apps/mobile
npx eas-cli build -p android --profile production
```

For a physical phone, the API URL cannot be `localhost` unless the API is running on the phone. Use your server URL or your Mac LAN IP, for example `http://192.168.1.100:7073`.

## Screens

- Home: session posture, quick actions, assigned-module watch, and latest alert shortcut.
- BUY & SELL: Short/Long setup tabs, actionable module setup cards, detail screen with entry range, SL, TP, RR, setup score, paper status, and grouped checklist evidence.
- Live Chart: selected-module XAUUSD chart using backend cache and websocket updates, with compact Module 1 ORB and Module 2 Ultimate Sweep overlay legends.
- Paper Trading: journal/performance view for automatic paper trades.
- More: alerts/history, push settings, security, assigned modules, support, app updates, websocket status, and app details.
- Home shows an update banner when Platform Admin has uploaded a newer APK; More > App Updates shows release details, changelog, file size, and download.

## Runtime Notes

- Keep the API on `http://localhost:7073` for simulator use.
- For a physical phone, the API must listen on the Mac LAN IP and the phone must be on the same network.
- Live chart updates come through `/api/live/ws`; pull-to-refresh is only a manual fallback.
