"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DISCORD_SCOPES,
  buildDiscordAuthorizeUrl,
  fetchDiscordGuildMember,
  memberHasRole
} = require("../src/discord");

test("Discord OAuth URL requests identify and guild member scopes", () => {
  const url = new URL(buildDiscordAuthorizeUrl({
    clientId: "client-id",
    redirectUri: "https://downloads.example.com/auth/discord/callback",
    authorizeUrl: "https://discord.example/oauth2/authorize"
  }, "signed-state"));

  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "signed-state");
  assert.deepEqual(url.searchParams.get("scope").split(" "), DISCORD_SCOPES);
});

test("memberHasRole checks role ids exactly", () => {
  assert.equal(memberHasRole({ roles: ["111", "222"] }, "222"), true);
  assert.equal(memberHasRole({ roles: ["moderator"] }, "222"), false);
  assert.equal(memberHasRole({ roles: [] }, "222"), false);
});

test("fetchDiscordGuildMember calls the current-user guild member endpoint", async () => {
  const seen = {};
  const member = await fetchDiscordGuildMember({
    apiBaseUrl: "https://discord.example/api/v10",
    guildId: "guild-123"
  }, "access-token", async (url, options) => {
    seen.url = url;
    seen.authorization = options.headers.authorization;
    return new Response(JSON.stringify({ roles: ["role-1"] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });

  assert.equal(seen.url, "https://discord.example/api/v10/users/@me/guilds/guild-123/member");
  assert.equal(seen.authorization, "Bearer access-token");
  assert.deepEqual(member.roles, ["role-1"]);
});
