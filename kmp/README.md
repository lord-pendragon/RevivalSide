# RevivalSide Android Profile Capture

Kotlin Multiplatform Android companion app for capturing the Android client `JOIN_LOBBY_ACK`.

## What It Does

- Runs as an Android `VpnService` packet capture app.
- Captures traffic from the selected CounterSide Android package.
- Forwards TCP/UDP traffic so the game can still log in normally.
- Scans server-to-client TCP payloads for packet `205` (`JOIN_LOBBY_ACK`).
- Exports a zip bundle with:
  - `manifest.json`
  - `server_001_205.packet.bin`
  - `server_001_205.payload.bin`

The Android app does not convert the packet into `users.json` on-device. Use the desktop RevivalSide capture/import tooling to convert the exported bundle.

## Install And Run

1. Connect an Android phone or emulator with USB debugging enabled.
2. Run:

   ```bat
   build-and-install.bat
   ```

3. Open **RevivalSide Capture**.
4. Leave the target package as `com.studiobside.CounterSide`, or change it if your installed build uses another package name.
5. Tap **Start** and accept the Android VPN prompt.
6. Open CounterSide and reach the lobby.
7. When the app shows `Captured JOIN_LOBBY_ACK`, tap **Share export** and send the zip to the desktop.

## Desktop Import

Unzip the exported bundle into a folder, then run the existing desktop importer against that folder:

```bat
node tools\import-official-join-lobby-profile.js --capture-dir <unzipped-bundle-folder> --copy-to exports\users-android.json
```

Then open User Manager and use **Import copied JSON**.

## Notes

- This is local-only. It does not upload captures.
- It needs Android VPN permission and cannot run alongside another VPN.
- It captures only IPv4 traffic. If the Android client uses IPv6-only networking on a device/network, use an IPv4-capable network or emulator.
- If the Android client moves the lobby payload inside TLS, this app can forward traffic but will not be able to read `JOIN_LOBBY_ACK`.
