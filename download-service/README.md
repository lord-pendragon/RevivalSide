# DownloadSide

DownloadSide is the Discord front door for RevivalSide release downloads and launcher entitlement. It keeps Discord and GitHub secrets on the server, verifies a user's Discord guild role, proxies private GitHub release assets to Setup, and lets Launcher prove entitlement before Start.

## Local Setup

```powershell
cd download-service
Copy-Item .env.example .env
npm install
npm run dev
```

Fill `.env` with a Discord OAuth app, the target guild and role IDs, and either `GITHUB_TOKEN` or GitHub App credentials that can read private release assets from `MadlyMoe/RevivalSide`.

Use these Discord OAuth scopes:

```text
identify guilds.members.read
```

## Routes

- `GET /health`
- `GET /auth/discord/login?deviceCode=...`
- `GET /auth/discord/callback`
- `GET|POST /auth/device/start`
- `GET /auth/device/:deviceCode/status`
- `GET /latest`
- `GET /releases/:tag/manifest`
- `GET /releases/:tag/assets/:assetName`

`/releases/:tag/manifest`, `/releases/:tag/assets/:assetName`, and `/latest` require:

```http
Authorization: Bearer <installToken>
```

## Device Flow

1. Setup starts a device authorization by calling `/auth/device/start`.
2. The browser redirects to Discord OAuth.
3. The callback exchanges the OAuth code server-side.
4. The service calls Discord's current-user guild member endpoint for `DISCORD_GUILD_ID`.
5. The service checks `roles` for `DISCORD_ALLOWED_ROLE_ID`.
6. Setup polls `/auth/device/:deviceCode/status`.
7. On success, the status response returns a short-lived install token.
8. Setup downloads release assets through this service with `Authorization: Bearer <token>`.
9. Setup writes `RevivalSideLauncher.auth.json` into the installed app folder so Launcher can use the same gateway for Start entitlement.

## GitHub Assets

The private GitHub release should contain:

```text
RevivalSidePayloadManifest.json
RevivalSidePayload-vX.Y.Z.zip
```

Split payload parts also work as long as the manifest's `chunks[].name` values match the GitHub release asset names.

The service fetches assets from private GitHub releases server-side. Do not put GitHub tokens, Discord client secrets, or GitHub App private keys in Setup or Launcher.

## Deploy DownloadSide

The included `Dockerfile` and `fly.toml` deploy DownloadSide as a single always-on Fly.io Machine at:

```text
https://downloadside.fly.dev
```

The service currently stores pending device auth codes in memory, so run one Machine until that store moves to Redis or another shared backend.

First, log in and create the app:

```powershell
cd C:\Main\Productivity\StopKillingGames\Projects\RevivalSide\download-service
flyctl auth login
flyctl apps create downloadside
```

Add this redirect URL in the Discord Developer Portal:

```text
https://downloadside.fly.dev/auth/discord/callback
```

Then fill `download-service\.env` with the same values you use locally and import Fly runtime secrets from that file. Do not commit `.env`.

```powershell
npm run secrets:fly
```

This reads non-empty DownloadSide deploy variables from `.env` and stages them with `flyctl secrets import --stage`.

Deploy:

```powershell
npm run deploy:fly
```

Smoke test:

```powershell
Invoke-RestMethod https://downloadside.fly.dev/health
```

## Packaging

Build the installer with the gateway release URL:

```powershell
npm run publish:github-release -- -ReleaseBaseUrl https://downloadside.fly.dev/releases/v0.3.0
```

For gateway URLs, the package script bakes the installer manifest URL as:

```text
https://downloadside.fly.dev/releases/v0.3.0/manifest
```

When Setup runs, it opens Discord sign-in, waits for the gateway to issue an install token, and uses that bearer token for the manifest and payload downloads.

After a gateway install, Launcher reads `RevivalSideLauncher.auth.json` and runs Discord device authorization once when the launcher opens. After that startup check succeeds, `START` uses the existing `npm run listen` path without prompting again in the same launcher process.

For source/dev testing, Launcher can also read `REVIVALSIDE_DOWNLOAD_GATEWAY_URL`, `REVIVALSIDE_LAUNCHER_AUTH_URL`, `DOWNLOAD_PUBLIC_BASE_URL`, or `download-service\.env` with `DOWNLOAD_PUBLIC_BASE_URL`. If none of those are present, source/dev runs are not gated and the launcher logs that Discord entitlement is not configured.

Or set `DOWNLOAD_PUBLIC_BASE_URL=https://downloadside.fly.dev` before running `tools\package-revivalside-github-release.ps1`; the packaging script will resolve `https://downloadside.fly.dev/releases/<tag>`.
