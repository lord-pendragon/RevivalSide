# DownloadSide

RevivalSide release payloads should live in private GitHub releases on `MadlyMoe/RevivalSide`. The public entry point is DownloadSide, the Discord-gated download service in `download-service`.

The service verifies Discord role membership with OAuth and keeps all secrets server-side. Setup receives a short-lived bearer token for release downloads, and Launcher receives a short-lived bearer token as proof of entitlement before Start. Redistributable apps must never contain a GitHub token, Discord client secret, or GitHub App private key.

## Required Environment

```text
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_REDIRECT_URI=
DISCORD_GUILD_ID=
DISCORD_ALLOWED_ROLE_ID=
SESSION_SECRET=
GITHUB_OWNER=MadlyMoe
GITHUB_REPO=RevivalSide
GITHUB_TOKEN=
SERVICE_NAME=DownloadSide
DOWNLOAD_PUBLIC_BASE_URL=https://downloadside.fly.dev
```

`GITHUB_TOKEN` can be replaced with GitHub App credentials; see `download-service\.env.example`.

## Packaging Command

For a gateway-hosted `v0.3.0` release:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\package-revivalside-github-release.ps1 -ReleaseBaseUrl https://downloadside.fly.dev/releases/v0.3.0
```

If `DOWNLOAD_PUBLIC_BASE_URL` is set to `https://downloadside.fly.dev`, the packaging script can derive the release base URL:

```powershell
$env:DOWNLOAD_PUBLIC_BASE_URL = "https://downloadside.fly.dev"
npm run publish:github-release
```

Upload the generated manifest and payload assets to the private `MadlyMoe/RevivalSide` release. Do not upload the payload to Discord, and do not point Setup at a private GitHub asset URL directly.

## Hosting

`download-service\Dockerfile` and `download-service\fly.toml` define the DownloadSide Fly.io deployment at `https://downloadside.fly.dev`.

```powershell
cd C:\Main\Productivity\StopKillingGames\Projects\RevivalSide\download-service
flyctl auth login
flyctl apps create downloadside
npm run secrets:fly
npm run deploy:fly
Invoke-RestMethod https://downloadside.fly.dev/health
```

`npm run secrets:fly` reads non-empty DownloadSide deploy variables from `download-service\.env` and stages them with `flyctl secrets import --stage`. `npm run deploy:fly` applies the staged secrets.

## Installer Flow

1. Setup creates or requests a random device code.
2. Setup opens the returned Discord verification URL in the user's browser.
3. The gateway verifies the user's Discord guild role by role ID.
4. Setup polls `/auth/device/:deviceCode/status`.
5. The gateway returns a short-lived install token.
6. Setup requests `/releases/:tag/manifest` and `/releases/:tag/assets/:assetName` with `Authorization: Bearer <token>`.

The installer still validates payload SHA-256 hashes from `RevivalSidePayloadManifest.json` after the gateway proxies the private release assets.

The installer now performs this flow automatically whenever the baked manifest URL points at a non-GitHub `/releases/...` gateway URL. Direct GitHub release manifest URLs remain unauthenticated and backward-compatible.

## Launcher Flow

After a gateway install, Setup writes `RevivalSideLauncher.auth.json` into the installed app folder. The file contains only the gateway URL and release manifest URL, not secrets.

When Launcher opens for the first time in a process, it:

1. Calls `/auth/device/start` on the configured gateway.
2. Opens the returned Discord verification URL.
3. Polls `/auth/device/:deviceCode/status`.
4. Marks the current launcher session as entitled after the gateway returns a short-lived token.

After that one startup check succeeds, `START` continues to the existing `npm run listen` path without prompting again during the same launcher process.

For source/dev testing, Launcher also accepts `REVIVALSIDE_DOWNLOAD_GATEWAY_URL`, `REVIVALSIDE_LAUNCHER_AUTH_URL`, `DOWNLOAD_PUBLIC_BASE_URL`, or `download-service\.env` with `DOWNLOAD_PUBLIC_BASE_URL`.

If no gateway config is found, Launcher logs that Discord entitlement is not configured and behaves like the source/dev launcher.
