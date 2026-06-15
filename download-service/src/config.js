"use strict";

function requireEnv(env, name) {
  const value = env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalTrim(env, name, fallback = "") {
  const value = env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function readConfig(env = process.env) {
  const sessionSecret = requireEnv(env, "SESSION_SECRET");
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters.");
  }

  const downloadPublicBaseUrl = requireEnv(env, "DOWNLOAD_PUBLIC_BASE_URL").replace(/\/+$/, "");
  const port = Number.parseInt(optionalTrim(env, "PORT", "8787"), 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a positive integer.");
  }

  const githubToken = optionalTrim(env, "GITHUB_TOKEN");
  const githubApp = {
    appId: optionalTrim(env, "GITHUB_APP_ID"),
    installationId: optionalTrim(env, "GITHUB_APP_INSTALLATION_ID"),
    privateKey: optionalTrim(env, "GITHUB_APP_PRIVATE_KEY")
  };
  const hasGitHubApp = githubApp.appId && githubApp.installationId && githubApp.privateKey;
  if (!githubToken && !hasGitHubApp) {
    throw new Error("Set GITHUB_TOKEN or GitHub App credentials with private release asset read access.");
  }

  return {
    serviceName: optionalTrim(env, "SERVICE_NAME", "DownloadSide"),
    port,
    downloadPublicBaseUrl,
    sessionSecret,
    deviceCodeTtlMs: Number.parseInt(optionalTrim(env, "DEVICE_CODE_TTL_SECONDS", "600"), 10) * 1000,
    oauthStateTtlMs: Number.parseInt(optionalTrim(env, "OAUTH_STATE_TTL_SECONDS", "600"), 10) * 1000,
    installTokenTtlMs: Number.parseInt(optionalTrim(env, "INSTALL_TOKEN_TTL_SECONDS", "900"), 10) * 1000,
    discord: {
      clientId: requireEnv(env, "DISCORD_CLIENT_ID"),
      clientSecret: requireEnv(env, "DISCORD_CLIENT_SECRET"),
      redirectUri: requireEnv(env, "DISCORD_REDIRECT_URI"),
      guildId: requireEnv(env, "DISCORD_GUILD_ID"),
      allowedRoleId: requireEnv(env, "DISCORD_ALLOWED_ROLE_ID"),
      authorizeUrl: optionalTrim(env, "DISCORD_AUTHORIZE_URL", "https://discord.com/oauth2/authorize"),
      tokenUrl: optionalTrim(env, "DISCORD_TOKEN_URL", "https://discord.com/api/oauth2/token"),
      apiBaseUrl: optionalTrim(env, "DISCORD_API_BASE_URL", "https://discord.com/api/v10").replace(/\/+$/, "")
    },
    github: {
      owner: optionalTrim(env, "GITHUB_OWNER", "MadlyMoe"),
      repo: optionalTrim(env, "GITHUB_REPO", "RevivalSide"),
      token: githubToken,
      app: hasGitHubApp ? githubApp : null,
      apiBaseUrl: optionalTrim(env, "GITHUB_API_BASE_URL", "https://api.github.com").replace(/\/+$/, "")
    }
  };
}

module.exports = { readConfig };
