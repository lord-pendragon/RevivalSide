"use strict";

const crypto = require("node:crypto");

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlJson(value) {
  return base64UrlEncode(JSON.stringify(value));
}

function sign(data, secret) {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

function signToken(payload, secret, ttlMs, now = Date.now()) {
  const body = {
    ...payload,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ttlMs) / 1000),
    jti: crypto.randomBytes(16).toString("base64url")
  };
  const encoded = base64UrlJson(body);
  return `${encoded}.${sign(encoded, secret)}`;
}

function verifyToken(token, secret, now = Date.now()) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    throw new Error("Missing or malformed token.");
  }

  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) throw new Error("Missing or malformed token.");

  const expected = sign(encoded, secret);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid token signature.");
  }

  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!payload.exp || payload.exp < Math.floor(now / 1000)) {
    throw new Error("Token expired.");
  }
  return payload;
}

function signOAuthState(secret, deviceCode, ttlMs) {
  return signToken({ type: "discord-oauth-state", deviceCode }, secret, ttlMs);
}

function verifyOAuthState(secret, state) {
  const payload = verifyToken(state, secret);
  if (payload.type !== "discord-oauth-state" || !payload.deviceCode) {
    throw new Error("Invalid OAuth state.");
  }
  return payload;
}

function signInstallToken(secret, claims, ttlMs) {
  return signToken({
    type: "revivalside-install-token",
    aud: "revivalside-downloads",
    scope: "release:download",
    ...claims
  }, secret, ttlMs);
}

function verifyInstallToken(secret, token) {
  const payload = verifyToken(token, secret);
  if (payload.type !== "revivalside-install-token" || payload.scope !== "release:download") {
    throw new Error("Invalid install token.");
  }
  return payload;
}

module.exports = {
  signToken,
  verifyToken,
  signOAuthState,
  verifyOAuthState,
  signInstallToken,
  verifyInstallToken
};
