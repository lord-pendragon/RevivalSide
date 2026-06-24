# RevivalSide

RevivalSide is a local CounterSide revival research server. It includes the Node.js TCP listener, packet handlers, capture tooling, a C# combat-host bridge, and project-built combat-host binaries.

This repository intentionally does not track client assets, raw packet captures, decompiled `Assembly-CSharp` source dumps, decrypted Lua bytecode, account databases, or raw game DLLs. Runtime gameplay tables can be loaded from the encrypted CounterSide install by deriving the script assets from the selected `Data\Managed` directory.

## What Is Tracked

- `cs-listener.js`: TCP listener, packet framing, HTTP mirror, login/session glue.
- `packet-handlers/`: request handlers for login, lobby, battle, cutscene, and utility packets.
- `combat-handler/`: Node-side combat session orchestration and bridge into the C# host.
- `combat-host/`: C# local combat host and managed assembly patcher.
- `prebuilt/combat-host/`: published RevivalSide combat host binaries.
- `tools/`: capture, table extraction, packet schema, and setup helper scripts.
- `gameplay-jsons/`: optional legacy parsed gameplay table fixtures. Normal listener runtime can use installed `.luac` assets instead.
- `stages/`: hand-authored stage definitions used by current tutorial work.
- `server-data/captured-*`: sanitized HTTP, login/content, and tutorial game-stream fixtures.
- `packet-schema.json`: generated protocol reference used for packet work.

## Quick Start

Start with [docs/setup.md](docs/setup.md). It is written for first-time users and walks through the wiki, local game data, hosts patching, and the listener without assuming software development experience.

The very short setup is:

```powershell
git clone https://github.com/MadlyMoe/RevivalSide.git RevivalSide
cd RevivalSide
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm install
npm run build:combat-host
```

Fresh local accounts and runtime features can use `.luac` tables cached from the encrypted assets next to `Data\Managed`, without requiring raw/decompiled table dumps or `gameplay-jsons`.

To run the local wiki:

```powershell
npm run wiki:build
npm run wiki:serve
```

To run the server listener, patch hosts from an elevated PowerShell prompt, then run:

```powershell
npm run listen
```

The default listener uses TCP `127.0.0.1:22000` and HTTP mirror `http://127.0.0.1:8088`.
The local user profile manager is served from the same process at `http://127.0.0.1:8088/user-manager`.

## Discord Tester Bot

The Discord management bot exposes one slash command, `/join`, which grants the
caller the `@Tester` role. Non-approved users have one day to receive the
`@Approved` role; if they do not, the bot removes `@Tester`.

Set these values in `.env` or in the shell before starting it:

```ini
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_GUILD_ID=your-server-id
DISCORD_TESTER_ROLE_ID=your-tester-role-id
DISCORD_TESTER_ROLE_NAME=Tester
DISCORD_APPROVED_ROLE_ID=your-approved-role-id
DISCORD_APPROVED_ROLE_NAME=Approved
DISCORD_TESTER_TIMER_STATE_PATH=.\server-data\discord-tester-timers.json
```

Role IDs are preferred; if an ID is empty, the bot looks for a role named by
the matching role-name variable. Already-approved users can use `/join` without
starting a timer. Timer state is saved to
`server-data\discord-tester-timers.json` by default, so restarts keep pending
deadlines.

The bot needs the `bot` and `applications.commands` OAuth scopes, the
`Manage Roles` permission, and its highest role must be above `@Tester`.

```powershell
npm run discord-bot
```
