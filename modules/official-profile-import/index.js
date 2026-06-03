const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const JOIN_LOBBY_ACK_PACKET_ID = 205;
const DEFAULT_NEXT_USER_UID = "1000000001";
const DEFAULT_NEXT_FRIEND_CODE = "10000001";
const CRYPTO_MASKS = Object.freeze([
  14170986657190717782n,
  15546886188969944187n,
  15913139373130964729n,
  3486779174683840252n,
]);

function createOfficialProfileImporter(options = {}) {
  const config = {
    rootDir: path.resolve(options.rootDir || path.join(__dirname, "..", "..")),
    captureDir: path.resolve(options.captureDir || path.join(__dirname, "..", "..", "server-data", "captured-game-flow")),
    userDb: options.userDb,
    combatHandler: options.combatHandler,
    ensureUserDefaults: options.ensureUserDefaults || ((user) => user),
    makeAccessToken: options.makeAccessToken || (() => crypto.randomBytes(16).toString("hex")),
    makeToken: options.makeToken || ((prefix) => `${prefix}_${crypto.randomBytes(24).toString("hex")}`),
  };

  function listSources() {
    const manifestPath = path.join(config.captureDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) return [];
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return (manifest.server || [])
      .map((entry, index) => buildSource(entry, index + 1))
      .filter(Boolean)
      .sort((left, right) => right.index - left.index);
  }

  function importLatest(options = {}) {
    const sources = listSources();
    if (!sources.length) {
      throw new Error(`No JOIN_LOBBY_ACK payloads found in ${config.captureDir}.`);
    }
    return importSource({ ...options, sourceId: options.sourceId || sources[0].id });
  }

  function importSource(options = {}) {
    const source = resolveSource(options);
    const capturedPayload = fs.readFileSync(source.payloadPath);
    const payloadSha256 = sha256(capturedPayload);
    const decodedPayload = decodeCapturedPayload(capturedPayload, source.compressed);
    const extracted = extractProfile(decodedPayload);
    const profile = buildSwitchableProfile(extracted.profile, {
      source,
      payloadSha256,
      packetType: extracted.packetType,
      summary: extracted.summary,
      preserveOfficialUid: options.preserveOfficialUid === true,
      preserveOfficialFriendCode: options.preserveOfficialFriendCode === true,
      switchActive: options.switchActive === true,
      updateExisting: options.updateExisting !== false,
      nicknameSuffix: options.nicknameSuffix,
    });

    return {
      user: profile,
      source: summarizeSource(source),
      payloadSha256,
      packetType: extracted.packetType,
      summary: extracted.summary,
      counts: buildCounts(profile),
      switched: options.switchActive === true,
    };
  }

  function buildSource(entry, index) {
    if (!entry || Number(entry.packetId) !== JOIN_LOBBY_ACK_PACKET_ID || !entry.payloadFile) return null;
    const payloadPath = path.resolve(config.captureDir, entry.payloadFile);
    if (!isInside(config.captureDir, payloadPath) || !fs.existsSync(payloadPath)) return null;
    return {
      id: `server:${index}`,
      index,
      packetId: Number(entry.packetId),
      payloadFile: entry.payloadFile,
      payloadPath,
      payloadSize: Number(entry.payloadSize || fs.statSync(payloadPath).size || 0),
      compressed: entry.compressed === true,
      sha256: String(entry.sha256 || ""),
      stream: entry.stream,
      frame: entry.frame,
      time: entry.time,
    };
  }

  function resolveSource(options) {
    if (options.payloadPath) {
      const payloadPath = path.resolve(String(options.payloadPath));
      if (!isInside(config.captureDir, payloadPath)) {
        throw new Error("JOIN_LOBBY_ACK payload path must stay inside the captured-game-flow directory.");
      }
      if (!fs.existsSync(payloadPath)) throw new Error(`JOIN_LOBBY_ACK payload not found: ${payloadPath}`);
      return {
        id: `file:${path.basename(payloadPath)}`,
        index: 0,
        packetId: JOIN_LOBBY_ACK_PACKET_ID,
        payloadFile: path.relative(config.captureDir, payloadPath),
        payloadPath,
        payloadSize: fs.statSync(payloadPath).size,
        compressed: options.compressed === true,
      };
    }

    const sources = listSources();
    const sourceId = String(options.sourceId || "").trim();
    const source = sourceId ? sources.find((item) => item.id === sourceId) : sources[0];
    if (!source) {
      throw new Error(sourceId ? `JOIN_LOBBY_ACK source ${sourceId} was not found.` : "No JOIN_LOBBY_ACK source was found.");
    }
    return source;
  }

  function extractProfile(payload) {
    if (!config.combatHandler || typeof config.combatHandler.extractJoinLobbyProfile !== "function") {
      throw new Error("Official profile import requires the C# combat host profile extractor.");
    }
    const result = config.combatHandler.extractJoinLobbyProfile(payload);
    if (!result || !result.ok || !result.profile) {
      throw new Error(result && result.error ? result.error : "JOIN_LOBBY_ACK profile extraction failed.");
    }
    return result;
  }

  function buildSwitchableProfile(extracted, options) {
    const userDb = ensureUserDb(config.userDb);
    const now = new Date().toISOString();
    const officialUid = nonEmpty(extracted.userUid);
    const targetUid = chooseLocalUserUid(userDb, extracted, options);
    const existing = userDb.users[targetUid] || null;
    const targetFriendCode = chooseLocalFriendCode(userDb, targetUid, extracted.friendCode, options);
    const profile = deepClone(extracted);
    const originalNickname = nonEmpty(profile.nickname) || "OfficialProfile";

    profile.userUid = targetUid;
    profile.friendCode = targetFriendCode;
    profile.nickname = nonEmpty(options.nicknameSuffix) ? `${originalNickname} ${options.nicknameSuffix}` : originalNickname;
    profile.createdAt = existing && existing.createdAt ? existing.createdAt : now;
    profile.importedAt = now;
    profile.lastLoginAt = "";
    profile.lastJoinAt = "";
    profile.accessToken = existing && existing.accessToken ? existing.accessToken : config.makeAccessToken();
    profile.reconnectKey = existing && existing.reconnectKey ? existing.reconnectKey : config.makeToken("rck");
    profile.lastTokenIssuedAt = existing && existing.lastTokenIssuedAt ? existing.lastTokenIssuedAt : now;
    profile.officialImport = {
      ...(profile.officialImport && typeof profile.officialImport === "object" ? profile.officialImport : {}),
      importedAt: now,
      source: "join_lobby_ack",
      sourceId: options.source.id,
      sourcePayloadFile: options.source.payloadFile,
      sourcePacketSha256: options.payloadSha256,
      packetType: options.packetType || "",
      summary: options.summary || "",
      officialUserUid: officialUid,
      officialFriendCode: nonEmpty(extracted.friendCode),
      localUserUid: targetUid,
      localFriendCode: targetFriendCode,
    };
    profile.importedOfficialProfile = true;

    retargetUnitOwnership(profile, targetUid);
    config.ensureUserDefaults(profile);
    retargetUnitOwnership(profile, targetUid);

    userDb.users[targetUid] = profile;
    if (options.switchActive) userDb.activeUserUid = targetUid;
    bumpNextNumericId(userDb, "nextUserUid", targetUid);
    bumpNextNumericId(userDb, "nextFriendCode", targetFriendCode);
    return profile;
  }

  function chooseLocalUserUid(userDb, extracted, options) {
    const officialUid = nonEmpty(extracted.userUid);
    if (options.updateExisting && officialUid) {
      const existingImported = Object.values(userDb.users || {}).find(
        (user) =>
          user &&
          user.officialImport &&
          String(user.officialImport.officialUserUid || "") === officialUid
      );
      if (existingImported && existingImported.userUid) return String(existingImported.userUid);
    }

    if (options.preserveOfficialUid && officialUid) {
      const existing = userDb.users[officialUid];
      if (!existing || isSameOfficialImport(existing, officialUid)) return officialUid;
    }

    return allocateNumericId(userDb, "nextUserUid", DEFAULT_NEXT_USER_UID, (candidate) => userDb.users[String(candidate)]);
  }

  function chooseLocalFriendCode(userDb, targetUid, officialFriendCode, options) {
    const preferred = nonEmpty(officialFriendCode);
    if (options.preserveOfficialFriendCode && preferred) {
      const conflict = Object.values(userDb.users || {}).find(
        (user) => user && String(user.userUid || "") !== targetUid && String(user.friendCode || "") === preferred
      );
      if (!conflict) return preferred;
    }
    const existing = userDb.users[targetUid];
    if (existing && existing.friendCode) return String(existing.friendCode);
    return allocateNumericId(userDb, "nextFriendCode", DEFAULT_NEXT_FRIEND_CODE, (candidate) =>
      Object.values(userDb.users || {}).some((user) => user && String(user.friendCode || "") === String(candidate))
    );
  }

  return {
    listSources,
    importLatest,
    importSource,
  };
}

function summarizeSource(source) {
  return {
    id: source.id,
    index: source.index,
    packetId: source.packetId,
    payloadFile: source.payloadFile,
    payloadSize: source.payloadSize,
    compressed: source.compressed === true,
    sha256: source.sha256 || "",
    stream: source.stream,
    frame: source.frame,
    time: source.time,
  };
}

function ensureUserDb(userDb) {
  if (!userDb || typeof userDb !== "object") throw new Error("User database is unavailable.");
  userDb.users = userDb.users && typeof userDb.users === "object" ? userDb.users : {};
  userDb.nextUserUid = String(userDb.nextUserUid || DEFAULT_NEXT_USER_UID);
  userDb.nextFriendCode = String(userDb.nextFriendCode || DEFAULT_NEXT_FRIEND_CODE);
  return userDb;
}

function isSameOfficialImport(user, officialUid) {
  return Boolean(
    user &&
      user.officialImport &&
      String(user.officialImport.officialUserUid || "") === String(officialUid || "")
  );
}

function retargetUnitOwnership(profile, userUid) {
  const army = profile.army && typeof profile.army === "object" ? profile.army : null;
  if (!army) return;
  for (const bucket of ["units", "ships", "trophies"]) {
    for (const unit of Object.values((army[bucket] && typeof army[bucket] === "object" ? army[bucket] : {}) || {})) {
      if (unit && typeof unit === "object") unit.userUid = userUid;
    }
  }
}

function buildCounts(profile) {
  return {
    miscItems: countObject(profile.inventory && profile.inventory.misc),
    equips: countObject(profile.inventory && profile.inventory.equips),
    skins: Array.isArray(profile.inventory && profile.inventory.skins) ? profile.inventory.skins.length : 0,
    units: countObject(profile.army && profile.army.units),
    ships: countObject(profile.army && profile.army.ships),
    trophies: countObject(profile.army && profile.army.trophies),
    operators: countObject(profile.army && profile.army.operators),
    stages: countObject(profile.stagePlayData),
    dungeons: countObject(profile.dungeonClear),
  };
}

function countObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : 0;
}

function allocateNumericId(db, field, fallback, exists) {
  let current = safeBigInt(db[field], fallback);
  while (exists(current)) current += 1n;
  db[field] = String(current + 1n);
  return String(current);
}

function bumpNextNumericId(db, field, value) {
  if (!value || !/^\d+$/.test(String(value))) return;
  const current = safeBigInt(db[field], field === "nextFriendCode" ? DEFAULT_NEXT_FRIEND_CODE : DEFAULT_NEXT_USER_UID);
  const next = BigInt(String(value)) + 1n;
  if (next > current) db[field] = String(next);
}

function safeBigInt(value, fallback) {
  try {
    return BigInt(String(value || fallback));
  } catch (_) {
    return BigInt(fallback);
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function decodeCapturedPayload(payload, compressed) {
  if (compressed) return lz4StreamDecompress(payload);
  return decryptCopy(payload);
}

function lz4StreamDecompress(payload) {
  let offset = 0;
  const chunks = [];
  while (offset < payload.length) {
    const flags = readVarInt(payload, offset);
    offset = flags.offset;
    const outputLength = readVarInt(payload, offset);
    offset = outputLength.offset;
    const compressed = (flags.value & 1) !== 0;
    let inputLength = outputLength.value;
    if (compressed) {
      const rawInputLength = readVarInt(payload, offset);
      offset = rawInputLength.offset;
      inputLength = rawInputLength.value;
    }
    const block = payload.subarray(offset, offset + inputLength);
    offset += inputLength;
    chunks.push(compressed ? lz4BlockDecode(block, outputLength.value) : Buffer.from(block));
  }
  return Buffer.concat(chunks);
}

function lz4BlockDecode(input, outputLength) {
  const output = Buffer.alloc(outputLength);
  let inputOffset = 0;
  let outputOffset = 0;

  while (inputOffset < input.length) {
    const token = input[inputOffset++];
    let literalLength = token >> 4;
    if (literalLength === 15) {
      let value;
      do {
        value = input[inputOffset++];
        literalLength += value;
      } while (value === 255);
    }

    input.copy(output, outputOffset, inputOffset, inputOffset + literalLength);
    inputOffset += literalLength;
    outputOffset += literalLength;
    if (inputOffset >= input.length) break;

    const matchOffset = input[inputOffset] | (input[inputOffset + 1] << 8);
    inputOffset += 2;
    let matchLength = token & 0x0f;
    if (matchLength === 15) {
      let value;
      do {
        value = input[inputOffset++];
        matchLength += value;
      } while (value === 255);
    }
    matchLength += 4;

    for (let index = 0; index < matchLength; index += 1) {
      output[outputOffset + index] = output[outputOffset - matchOffset + index];
    }
    outputOffset += matchLength;
  }

  if (outputOffset !== outputLength) {
    throw new Error(`lz4 output length mismatch: expected ${outputLength}, decoded ${outputOffset}`);
  }
  return output;
}

function decryptCopy(payload) {
  const copy = Buffer.from(payload);
  encryptPayload(copy);
  return copy;
}

function encryptPayload(buffer) {
  let offset = 0;
  let maskIndex = 0;
  while (offset < buffer.length) {
    const mask = CRYPTO_MASKS[maskIndex];
    if (buffer.length - offset >= 8) {
      const value = buffer.readBigUInt64LE(offset) ^ mask;
      buffer.writeBigUInt64LE(value, offset);
      offset += 8;
    } else {
      const key = Number(mask & 0xffn);
      while (offset < buffer.length) {
        buffer[offset] ^= key;
        offset += 1;
      }
    }
    maskIndex = (maskIndex + 1) % CRYPTO_MASKS.length;
  }
}

function readVarInt(buffer, offset) {
  let result = 0;
  let shift = 0;
  let current = offset;
  while (current < buffer.length) {
    const byte = buffer[current++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, offset: current };
    shift += 7;
  }
  throw new Error("unterminated varint");
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function nonEmpty(value) {
  return value == null ? "" : String(value).trim();
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

module.exports = {
  createOfficialProfileImporter,
  JOIN_LOBBY_ACK_PACKET_ID,
};
