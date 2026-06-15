"use strict";

const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { httpError } = require("./http-error");

const MANIFEST_ASSET_NAME = "RevivalSidePayloadManifest.json";

class GitHubClient {
  constructor({ owner, repo, token, app, apiBaseUrl, fetchImpl = fetch }) {
    this.owner = owner;
    this.repo = repo;
    this.token = token;
    this.app = app;
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.installationToken = null;
  }

  async getLatestRelease() {
    const response = await this.githubFetch(`/repos/${this.owner}/${this.repo}/releases/latest`);
    return readJsonOrThrow(response, "GitHub latest release lookup failed.");
  }

  async getReleaseByTag(tag) {
    const response = await this.githubFetch(`/repos/${this.owner}/${this.repo}/releases/tags/${encodeURIComponent(tag)}`);
    return readJsonOrThrow(response, `GitHub release lookup failed for ${tag}.`);
  }

  async fetchManifest(tag) {
    const release = await this.getReleaseByTag(tag);
    const asset = findReleaseAsset(release, MANIFEST_ASSET_NAME);
    if (!asset) throw httpError(404, `Release ${tag} does not include ${MANIFEST_ASSET_NAME}.`);

    const response = await this.fetchAsset(asset);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (error) {
      throw httpError(502, `${MANIFEST_ASSET_NAME} is not valid JSON.`, { message: error.message });
    }
  }

  async fetchReleaseAsset(tag, assetName) {
    const release = await this.getReleaseByTag(tag);
    const asset = findReleaseAsset(release, assetName);
    if (!asset) throw httpError(404, `Release ${tag} does not include asset ${assetName}.`);
    return { asset, response: await this.fetchAsset(asset) };
  }

  async fetchAsset(asset) {
    const response = await this.githubFetch(asset.url, {
      headers: { accept: "application/octet-stream" }
    });
    if (!response.ok) {
      const details = await readUpstreamError(response);
      throw httpError(response.status, `GitHub asset download failed for ${asset.name}.`, details);
    }
    return response;
  }

  async githubFetch(pathOrUrl, options = {}) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.apiBaseUrl}${pathOrUrl}`;
    const headers = {
      accept: "application/vnd.github+json",
      "user-agent": "RevivalSide-download-service",
      "x-github-api-version": "2022-11-28",
      ...(options.headers || {})
    };
    if (!headers.authorization && !headers.Authorization) {
      headers.authorization = `Bearer ${await this.getAuthToken()}`;
    }
    return this.fetchImpl(url, { ...options, headers });
  }

  async getAuthToken() {
    if (this.token) return this.token;
    if (!this.app) throw httpError(500, "GitHub credentials are not configured.");

    const now = Date.now();
    if (this.installationToken && this.installationToken.refreshAfter > now) {
      return this.installationToken.token;
    }

    const jwt = createGitHubAppJwt(this.app);
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/app/installations/${encodeURIComponent(this.app.installationId)}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "user-agent": "RevivalSide-download-service",
          "x-github-api-version": "2022-11-28"
        }
      }
    );
    const payload = await readJsonOrThrow(response, "GitHub App installation token lookup failed.");
    this.installationToken = {
      token: payload.token,
      refreshAfter: Date.parse(payload.expires_at) - 60_000
    };
    return payload.token;
  }
}

function findReleaseAsset(release, assetName) {
  return Array.isArray(release?.assets)
    ? release.assets.find((asset) => asset.name === assetName)
    : null;
}

function pipeWebResponseToExpress(response, res) {
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const contentLength = response.headers.get("content-length");
  res.setHeader("content-type", contentType);
  if (contentLength) res.setHeader("content-length", contentLength);
  if (!response.body) {
    res.end();
    return;
  }
  Readable.fromWeb(response.body).pipe(res);
}

function createGitHubAppJwt(app, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000) - 60;
  const expiresAt = issuedAt + 9 * 60;
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iat: issuedAt,
    exp: expiresAt,
    iss: app.appId
  })).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const privateKey = app.privateKey.replace(/\\n/g, "\n");
  return `${unsigned}.${signer.sign(privateKey, "base64url")}`;
}

async function readJsonOrThrow(response, message) {
  const payload = await readMaybeJson(response);
  if (!response.ok) {
    throw httpError(response.status, message, payload);
  }
  return payload;
}

async function readUpstreamError(response) {
  return readMaybeJson(response).catch((error) => ({ message: error.message }));
}

async function readMaybeJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { body: text.slice(0, 500) };
  }
}

module.exports = {
  GitHubClient,
  MANIFEST_ASSET_NAME,
  createGitHubAppJwt,
  findReleaseAsset,
  pipeWebResponseToExpress
};
