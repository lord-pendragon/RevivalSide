"use strict";

const crypto = require("node:crypto");

const DEVICE_CODE_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;

function generateDeviceCode() {
  return crypto.randomBytes(32).toString("base64url");
}

class DeviceStore {
  constructor({ ttlMs }) {
    this.ttlMs = ttlMs;
    this.records = new Map();
  }

  create(deviceCode = generateDeviceCode()) {
    this.cleanup();
    if (!DEVICE_CODE_PATTERN.test(deviceCode)) {
      throw new Error("deviceCode must be 16-128 URL-safe characters.");
    }

    const now = Date.now();
    const existing = this.records.get(deviceCode);
    if (existing && existing.expiresAt > now) return existing;

    const record = {
      deviceCode,
      status: "pending",
      createdAt: now,
      expiresAt: now + this.ttlMs
    };
    this.records.set(deviceCode, record);
    return record;
  }

  get(deviceCode) {
    this.cleanup();
    return this.records.get(deviceCode) || null;
  }

  authorize(deviceCode, authorization) {
    const record = this.get(deviceCode);
    if (!record) throw new Error("Unknown or expired device code.");
    Object.assign(record, {
      status: "authorized",
      authorizedAt: Date.now(),
      ...authorization
    });
    return record;
  }

  deny(deviceCode, reason) {
    const record = this.get(deviceCode);
    if (!record) return null;
    Object.assign(record, {
      status: "denied",
      deniedAt: Date.now(),
      reason
    });
    return record;
  }

  cleanup(now = Date.now()) {
    for (const [deviceCode, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(deviceCode);
    }
  }
}

module.exports = { DeviceStore, DEVICE_CODE_PATTERN, generateDeviceCode };
