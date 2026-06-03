const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const LOGIN_ACK = 203;
const CRYPTO_MASKS = Object.freeze([
  14170986657190717782n,
  15546886188969944187n,
  15913139373130964729n,
  3486779174683840252n,
]);

const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.source || path.join(ROOT_DIR, "server-data", "captured-tcp"));
const outputPath = path.resolve(args.output || path.join(sourceDir, "official-login-template.json"));
const manifestPath = path.join(sourceDir, "manifest.json");

if (!fs.existsSync(manifestPath)) {
  throw new Error(`Captured TCP manifest was not found: ${manifestPath}`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const entry = manifest[String(LOGIN_ACK)];
if (!entry || !entry.payloadFile) {
  throw new Error(`Captured TCP manifest does not contain packet ${LOGIN_ACK}.`);
}

const payloadPath = safeJoin(sourceDir, entry.payloadFile, "payloadFile");
const payload = fs.readFileSync(payloadPath);
const raw = entry.compressed === true ? lz4StreamDecompress(payload) : decryptCopy(payload);
const parsed = parseLoginAck(raw);

const template = {
  packetId: LOGIN_ACK,
  sourcePayloadSha256: sha256(payload),
  generatedAt: new Date().toISOString(),
  errorCode: parsed.errorCode,
  contentsVersion: parsed.contentsVersion,
  contentsTag: parsed.contentsTag,
  openTag: parsed.openTag,
  tokenLength: parsed.accessToken.length,
  gameServerIPLength: parsed.gameServerIP.length,
  gameServerPort: parsed.gameServerPort,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
console.log(
  `Wrote sanitized login template: ${outputPath} (contentsTags=${template.contentsTag.length}, openTags=${template.openTag.length})`
);

function parseLoginAck(buffer) {
  let offset = 0;
  const errorCode = readSignedVarInt(buffer, offset);
  offset = errorCode.offset;
  const accessToken = readString(buffer, offset);
  offset = accessToken.offset;
  const gameServerIP = readString(buffer, offset);
  offset = gameServerIP.offset;
  const gameServerPort = readSignedVarInt(buffer, offset);
  offset = gameServerPort.offset;
  const contentsVersion = readString(buffer, offset);
  offset = contentsVersion.offset;
  const contentsTag = readStringList(buffer, offset);
  offset = contentsTag.offset;
  const openTag = readStringList(buffer, offset);
  return {
    errorCode: errorCode.value,
    accessToken: accessToken.value || "",
    gameServerIP: gameServerIP.value || "",
    gameServerPort: gameServerPort.value || 0,
    contentsVersion: contentsVersion.value || "",
    contentsTag: contentsTag.value,
    openTag: openTag.value,
  };
}

function safeJoin(root, relativePath, fieldName) {
  const text = String(relativePath || "");
  if (!text || text.includes("..") || path.isAbsolute(text)) {
    throw new Error(`Unsafe ${fieldName} in manifest: ${text}`);
  }
  const resolved = path.resolve(root, text);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe ${fieldName} in manifest: ${text}`);
  }
  return resolved;
}

function decodeSigned32(value) {
  return (value >>> 1) ^ -(value & 1);
}

function readVarInt(buffer, offset) {
  let result = 0;
  let shift = 0;
  let current = offset;
  while (current < buffer.length && shift < 32) {
    const byte = buffer[current++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, offset: current };
    shift += 7;
  }
  throw new Error("unterminated varint32");
}

function readSignedVarInt(buffer, offset) {
  const raw = readVarInt(buffer, offset);
  return { value: decodeSigned32(raw.value), offset: raw.offset };
}

function readString(buffer, offset) {
  const length = readSignedVarInt(buffer, offset);
  offset = length.offset;
  if (length.value === -1) return { value: "", offset };
  if (length.value < 0 || offset + length.value > buffer.length) {
    throw new Error(`invalid string length ${length.value} at ${offset}`);
  }
  const value = buffer.subarray(offset, offset + length.value).toString("utf8");
  return { value, offset: offset + length.value };
}

function readStringList(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const item = readString(buffer, offset);
    offset = item.offset;
    values.push(item.value || "");
  }
  return { value: values, offset };
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

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    parsed[key] = values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : "1";
  }
  return parsed;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
