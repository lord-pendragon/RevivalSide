"use strict";

const express = require("express");
const { readConfig } = require("./config");
const { DeviceStore } = require("./devices");
const {
  buildDiscordAuthorizeUrl,
  exchangeDiscordCode,
  fetchDiscordGuildMember,
  memberHasRole
} = require("./discord");
const {
  GitHubClient,
  pipeWebResponseToExpress
} = require("./github");
const { httpError } = require("./http-error");
const {
  signOAuthState,
  verifyOAuthState,
  signInstallToken,
  verifyInstallToken
} = require("./tokens");

function createApp({ config = readConfig(), fetchImpl = fetch } = {}) {
  const app = express();
  const devices = new DeviceStore({ ttlMs: config.deviceCodeTtlMs });
  const github = new GitHubClient({ ...config.github, fetchImpl });

  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get("/", (req, res) => {
    res.type("html").send(renderHomePage(config.serviceName));
  });

  app.get("/health", (req, res) => {
    res.json({ ok: true, service: config.serviceName });
  });

  app.all("/auth/device/start", (req, res, next) => {
    try {
      const requestedCode = req.method === "GET" ? req.query.deviceCode : req.body?.deviceCode;
      const record = devices.create(typeof requestedCode === "string" ? requestedCode : undefined);
      res.json(deviceStartResponse(config, record));
    } catch (error) {
      next(error);
    }
  });

  app.get("/auth/device/:deviceCode/status", (req, res) => {
    const record = devices.get(req.params.deviceCode);
    if (!record) {
      res.status(404).json({ status: "expired" });
      return;
    }

    if (record.status === "authorized") {
      res.json({
        status: "authorized",
        installToken: record.installToken,
        tokenType: "Bearer",
        expiresAt: new Date(record.tokenExpiresAt).toISOString()
      });
      return;
    }

    if (record.status === "denied") {
      res.status(403).json({ status: "denied", reason: record.reason || "access_denied" });
      return;
    }

    res.json({ status: "pending" });
  });

  app.get("/auth/discord/login", (req, res, next) => {
    try {
      const deviceCode = requireDeviceCode(req.query.deviceCode);
      devices.create(deviceCode);
      const state = signOAuthState(config.sessionSecret, deviceCode, config.oauthStateTtlMs);
      res.redirect(buildDiscordAuthorizeUrl(config.discord, state));
    } catch (error) {
      next(error);
    }
  });

  app.get("/auth/discord/callback", async (req, res, next) => {
    let deviceCode = null;
    try {
      if (req.query.error) {
        throw httpError(403, `Discord authorization failed: ${req.query.error}`);
      }

      const state = verifyOAuthState(config.sessionSecret, requireQueryString(req.query.state, "state"));
      deviceCode = state.deviceCode;
      const code = requireQueryString(req.query.code, "code");
      const token = await exchangeDiscordCode(config.discord, code, fetchImpl);
      const member = await fetchDiscordGuildMember(config.discord, token.access_token, fetchImpl);

      if (!memberHasRole(member, config.discord.allowedRoleId)) {
        devices.deny(deviceCode, "missing_required_discord_role");
        res.status(403).send(renderCallbackPage(config.serviceName, "Access denied", "Your Discord account is in the server, but it does not have the required RevivalSide role."));
        return;
      }

      const userId = member.user?.id || "discord-user";
      const tokenExpiresAt = Date.now() + config.installTokenTtlMs;
      const installToken = signInstallToken(config.sessionSecret, {
        sub: userId,
        guildId: config.discord.guildId,
        deviceCode
      }, config.installTokenTtlMs);
      devices.authorize(deviceCode, { installToken, tokenExpiresAt, userId });
      res.send(renderCallbackPage(config.serviceName, "Access granted", "You can return to RevivalSide."));
    } catch (error) {
      if (deviceCode) devices.deny(deviceCode, "authorization_failed");
      next(error);
    }
  });

  app.get("/latest", requireInstallToken(config), async (req, res, next) => {
    try {
      const release = await github.getLatestRelease();
      res.json({
        tag: release.tag_name,
        name: release.name || release.tag_name,
        publishedAt: release.published_at,
        manifestUrl: `${config.downloadPublicBaseUrl}/releases/${encodeURIComponent(release.tag_name)}/manifest`
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/releases/:tag/manifest", requireInstallToken(config), async (req, res, next) => {
    try {
      const manifest = await github.fetchManifest(req.params.tag);
      res.setHeader("cache-control", "private, max-age=60");
      res.json(manifest);
    } catch (error) {
      next(error);
    }
  });

  app.get("/releases/:tag/assets/:assetName", requireInstallToken(config), async (req, res, next) => {
    try {
      await proxyAsset(github, req.params.tag, req.params.assetName, res);
    } catch (error) {
      next(error);
    }
  });

  app.get("/releases/:tag/:assetName", requireInstallToken(config), async (req, res, next) => {
    try {
      await proxyAsset(github, req.params.tag, req.params.assetName, res);
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res, next) => {
    next(httpError(404, "Route not found."));
  });

  app.use((error, req, res, _next) => {
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    const message = statusCode >= 500 ? "Internal server error." : error.message;
    if (req.path.startsWith("/auth/discord/callback")) {
      res.status(statusCode).send(renderCallbackPage(config.serviceName, "Authorization failed", message));
      return;
    }
    res.status(statusCode).json({ error: message });
  });

  return { app, devices, github };
}

function requireInstallToken(config) {
  return (req, res, next) => {
    try {
      const header = req.get("authorization") || "";
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (!match) throw httpError(401, "Missing bearer token.");
      req.installToken = verifyInstallToken(config.sessionSecret, match[1]);
      next();
    } catch (error) {
      next(httpError(401, error.message));
    }
  };
}

async function proxyAsset(github, tag, assetName, res) {
  const { asset, response } = await github.fetchReleaseAsset(tag, assetName);
  res.setHeader("cache-control", "private, max-age=60");
  res.setHeader("content-disposition", `attachment; filename="${asset.name.replace(/"/g, "")}"`);
  pipeWebResponseToExpress(response, res);
}

function deviceStartResponse(config, record) {
  const publicBaseUrl = config.downloadPublicBaseUrl;
  const loginUrl = new URL("/auth/discord/login", publicBaseUrl);
  loginUrl.searchParams.set("deviceCode", record.deviceCode);
  return {
    deviceCode: record.deviceCode,
    verificationUri: loginUrl.toString(),
    statusUri: `${publicBaseUrl}/auth/device/${encodeURIComponent(record.deviceCode)}/status`,
    expiresAt: new Date(record.expiresAt).toISOString()
  };
}

function requireDeviceCode(value) {
  return requireQueryString(value, "deviceCode");
}

function requireQueryString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw httpError(400, `Missing required query parameter: ${name}`);
  }
  return value.trim();
}

function renderCallbackPage(serviceName, title, message) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} | ${escapeHtml(serviceName)}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 3rem; line-height: 1.5; color: #f4f4f5; background: #18181b; }
    main { max-width: 44rem; }
  </style>
</head>
<body>
  <main>
    <p>${escapeHtml(serviceName)}</p>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </main>
</body>
</html>`;
}

function renderHomePage(serviceName) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(serviceName)}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 3rem; line-height: 1.5; color: #f4f4f5; background: #18181b; }
    main { max-width: 48rem; }
    button, a { color: #18181b; background: #f4f4f5; border: 0; border-radius: 6px; padding: 0.65rem 0.9rem; font: inherit; text-decoration: none; cursor: pointer; }
    pre { white-space: pre-wrap; background: #27272a; padding: 1rem; border-radius: 6px; overflow-wrap: anywhere; }
    .actions { display: flex; gap: 0.75rem; flex-wrap: wrap; margin: 1rem 0; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(serviceName)}</h1>
    <p>The download gateway is running. Use RevivalSide Setup to sign in and download release payloads.</p>
    <div class="actions">
      <a href="/health">Health</a>
    </div>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = { createApp };
