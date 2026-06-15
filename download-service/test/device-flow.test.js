"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");

const config = {
  port: 0,
  downloadPublicBaseUrl: "http://downloads.test",
  sessionSecret: "0123456789abcdef0123456789abcdef",
  deviceCodeTtlMs: 600000,
  oauthStateTtlMs: 600000,
  installTokenTtlMs: 900000,
  discord: {
    clientId: "discord-client",
    clientSecret: "discord-secret",
    redirectUri: "http://downloads.test/auth/discord/callback",
    guildId: "guild-123",
    allowedRoleId: "role-allowed",
    authorizeUrl: "https://discord.example/oauth2/authorize",
    tokenUrl: "https://discord.example/api/oauth2/token",
    apiBaseUrl: "https://discord.example/api/v10"
  },
  github: {
    owner: "MadlyMoe",
    repo: "RevivalSide",
    token: "github-token",
    app: null,
    apiBaseUrl: "https://api.github.example"
  }
};

test("device auth issues an install token that unlocks release manifest proxy", async () => {
  const fetchCalls = [];
  const fetchImpl = async (url, options = {}) => {
    fetchCalls.push({ url, options });

    if (url === config.discord.tokenUrl) {
      return jsonResponse({ access_token: "discord-access-token", token_type: "Bearer" });
    }

    if (url === `${config.discord.apiBaseUrl}/users/@me/guilds/${config.discord.guildId}/member`) {
      return jsonResponse({ user: { id: "discord-user-1" }, roles: ["role-allowed"] });
    }

    if (url === `${config.github.apiBaseUrl}/repos/MadlyMoe/RevivalSide/releases/tags/v0.2.0`) {
      return jsonResponse({
        tag_name: "v0.2.0",
        assets: [
          { name: "RevivalSidePayloadManifest.json", url: `${config.github.apiBaseUrl}/assets/manifest` }
        ]
      });
    }

    if (url === `${config.github.apiBaseUrl}/assets/manifest`) {
      assert.equal(options.headers.authorization, "Bearer github-token");
      assert.equal(options.headers.accept, "application/octet-stream");
      return jsonResponse({
        schemaVersion: 1,
        payloadId: "revivalside-v0.2.0-test",
        archiveName: "RevivalSidePayload-v0.2.0.zip",
        archiveSize: 123,
        archiveSha256: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        chunks: [
          {
            name: "RevivalSidePayload-v0.2.0.zip",
            size: 123,
            sha256: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
          }
        ]
      });
    }

    throw new Error(`unexpected fetch: ${url}`);
  };

  const { app } = createApp({ config, fetchImpl });
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const started = await fetchJson(`${base}/auth/device/start`, { method: "POST" });
    assert.equal(started.response.status, 200);
    assert.ok(started.body.deviceCode);

    const login = await fetch(`${base}/auth/discord/login?deviceCode=${encodeURIComponent(started.body.deviceCode)}`, {
      redirect: "manual"
    });
    assert.equal(login.status, 302);
    const discordUrl = new URL(login.headers.get("location"));
    assert.equal(discordUrl.origin, "https://discord.example");
    assert.equal(discordUrl.searchParams.get("scope"), "identify guilds.members.read");

    const callback = await fetch(`${base}/auth/discord/callback?code=discord-code&state=${encodeURIComponent(discordUrl.searchParams.get("state"))}`);
    assert.equal(callback.status, 200);

    const status = await fetchJson(`${base}/auth/device/${encodeURIComponent(started.body.deviceCode)}/status`);
    assert.equal(status.response.status, 200);
    assert.equal(status.body.status, "authorized");
    assert.ok(status.body.installToken);

    const locked = await fetch(`${base}/releases/v0.2.0/manifest`);
    assert.equal(locked.status, 401);

    const manifest = await fetchJson(`${base}/releases/v0.2.0/manifest`, {
      headers: { authorization: `Bearer ${status.body.installToken}` }
    });
    assert.equal(manifest.response.status, 200);
    assert.equal(manifest.body.archiveName, "RevivalSidePayload-v0.2.0.zip");
    assert.equal(fetchCalls.some((call) => call.url.includes("/releases/tags/v0.2.0")), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}
