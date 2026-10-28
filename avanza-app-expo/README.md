# avanza-app-expo

Expo SDK 54 (React Native 0.81, React 19.1, expo-router 6) multi-platform client
for the Avanza Control Matrix. The dashboard is **server-driven**: the
orchestrator Worker emits an OpenUI Lang program at `/sdui/manifest?stream=1`,
which streams line-by-line into `<Renderer />` from `@openuidev/react-lang`
against the typed component library in `src/sdui/library.tsx`
(`AvanzaDashboard → OutageBanner | StatRow → StatTile | ZoneGrid → ZoneCard → DeviceRow`).
A native live registry (devices, outage pill, inspector sheet) renders alongside
so the app is fully functional even before the first SDUI stream lands.

## Layout

```
expo-app/
├── app.json                  # expo config (dark UI, expo-router, notifications)
├── package.json              # SDK 54 locked tree + @openuidev/lang-core/react-lang
├── tsconfig.json
├── app/
│   ├── _layout.tsx           # dark Stack, notification handler, push registration
│   └── index.tsx             # SDUI dashboard + device inspector + temp-access sheet
└── src/
    ├── lib/api.ts            # orchestrator client (SecureStore-backed app token)
    └── sdui/
        ├── library.tsx       # OpenUI Lang component library (zod-typed)
        └── useOpenUIStream.ts# streaming fetch hook feeding the Renderer
```

## Setup

```sh
cd expo-app
npm install                                   # postinstall runs `expo install --fix`
# point the app at your worker:
#   app.json → expo.extra.orchUrl  (or EXPO_PUBLIC_ORCH_URL)
#   EXPO_PUBLIC_APP_CONTROL_KEY=<same value as wrangler secret APP_CONTROL_KEY>
npx expo start                                # scan QR: iOS/Android, or press w for web
```

`APP_CONTROL_KEY` is persisted into the device Keychain/Keystore via
`expo-secure-store` on first launch and never logged. The phone registers its
Expo push token with the orchestrator (`/api/control/push-register`) so outage
verdicts arrive as native notifications.

## Inspector interactions

- Tap any device (SDUI `DeviceRow` fires `@SelectDevice(ip)`; native rows do the same).
- **Privacy footprint**: computed grade + top observed destinations (metadata only —
  the router never exports payloads).
- **Layer 7 priority lane**: 🎮 EF (priority) / 📺 AF41 (video) / 📦 CS1 (bulk) / BE.
  `POST /api/control/lane` → DO override → agent materializes an nft lane-set
  element on the next 60 s cycle.
- **[Grant Temporary Phone Access]**: `POST /api/control/temp-access` (phone IP →
  device IP, 15 min). The agent snapshots config, adds a scoped UCI ACCEPT rule,
  arms the 10-minute rollback watchdog, and auto-deletes the rule at expiry.
- **⏸ Pause Internet (parental)**: `POST /api/control/pause` (1 h or indefinite,
  `resume:true` to lift) → agent applies a snapshot-first UCI REJECT rule with
  auto-expiry; paused devices show ⏸ in the registry list.
- **⚡ Speed test**: `POST /api/control/speedtest` → agent runs
  `speedtest.sh` (uclient-fetch vs speed.cloudflare.com) → result lands in
  `GET /api/speedtest` on the next telemetry cycle and renders in the WAN
  Speedtest card.

## Fire TV (same APK, D-pad route)

```sh
npx expo run:android --variant release      # or eas build -p android
adb connect <fire-tv-ip>:5555 && adb install build/app-release.apk
# launch straight into the TV surface:
adb shell am start -a android.intent.action.VIEW -d "avanza://tv" com.avanza.controlmatrix
```

`app/tv.tsx` is a focus-first screen: big tiles for **[⚡ Boost this TV]**
(sets its own CAKE lane to EF priority for 2 h — the "app enhances the network"
loop), router-side **speed test** trigger + result, and a **cast-help** tile
explaining the umdns 5353 reflection dependency. The device's LAN IP is stored
via SecureStore, so lane control targets the TV itself.

## Notes

- `@openuidev/*` packages are real npm packages (`lang-core` 0.2.x); if a pin
  drifts, adjust the `component` renderer signatures in `library.tsx` — the
  props/action contracts are zod-validated either way.
- Web output (`expo start --web`) is supported; SDUI streaming uses standard
  `ReadableStream` APIs available in all three targets.
