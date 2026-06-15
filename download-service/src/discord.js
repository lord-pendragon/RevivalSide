"use strict";

const { httpError } = require("./http-error");

const DISCORD_SCOPES = ["identify", "guilds.members.read"];

function buildDiscordAuthorizeUrl(discord, state) {
  const url = new URL(discord.authorizeUrl);
  url.searchParams.set("client_id", discord.clientId);
  url.searchParams.set("redirect_uri", discord.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", DISCORD_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

async function exchangeDiscordCode(discord, code, fetchImpl = fetch) {
  const body = new URLSearchParams({
    client_id: discord.clientId,
    client_secret: discord.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: discord.redirectUri
  });

  const response = await fetchImpl(discord.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });

  const payload = await readJson(response);
  if (!response.ok) {
    throw httpError(response.status, "Discord OAuth token exchange failed.", payload);
  }
  if (!payload.access_token) {
    throw httpError(502, "Discord OAuth response did not include an access token.");
  }
  return payload;
}

async function fetchDiscordGuildMember(discord, accessToken, fetchImpl = fetch) {
  const url = `${discord.apiBaseUrl}/users/@me/guilds/${encodeURIComponent(discord.guildId)}/member`;
  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json"
    }
  });

  const payload = await readJson(response);
  if (!response.ok) {
    if (response.status === 404) {
      throw httpError(403, "Discord user is not a member of the configured guild.", payload);
    }
    throw httpError(response.status, "Discord guild member lookup failed.", payload);
  }
  return payload;
}

function memberHasRole(member, roleId) {
  return Array.isArray(member?.roles) && member.roles.includes(roleId);
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw httpError(502, "Upstream returned invalid JSON.", { message: error.message });
  }
}

module.exports = {
  DISCORD_SCOPES,
  buildDiscordAuthorizeUrl,
  exchangeDiscordCode,
  fetchDiscordGuildMember,
  memberHasRole
};
