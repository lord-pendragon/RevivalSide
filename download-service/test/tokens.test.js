"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  signInstallToken,
  verifyInstallToken,
  signOAuthState,
  verifyOAuthState
} = require("../src/tokens");

const secret = "0123456789abcdef0123456789abcdef";

test("install tokens are signed and scoped", () => {
  const token = signInstallToken(secret, { sub: "user-1", guildId: "guild-1" }, 60_000);
  const payload = verifyInstallToken(secret, token);
  assert.equal(payload.sub, "user-1");
  assert.equal(payload.scope, "release:download");
});

test("tampered install tokens are rejected", () => {
  const token = signInstallToken(secret, { sub: "user-1" }, 60_000);
  assert.throws(() => verifyInstallToken(secret, `${token}x`), /signature|malformed/i);
});

test("OAuth state carries the device code", () => {
  const state = signOAuthState(secret, "device-code-123456", 60_000);
  assert.equal(verifyOAuthState(secret, state).deviceCode, "device-code-123456");
});
