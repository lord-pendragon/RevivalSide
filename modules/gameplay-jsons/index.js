const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DEFAULT_GAMEPLAY_TABLE_ROOT = path.join(ROOT_DIR, "gameplay-jsons");
const TABLE_ROOT_NAMES = new Set(["assetbundles", "streamingassets"]);

function getGameplayTableRoots(options = {}) {
  const rootDir = path.resolve(options.rootDir || ROOT_DIR);
  const env = options.env || process.env;
  const explicitValue =
    options.explicitRoots ||
    (options.explicitEnvName ? env[options.explicitEnvName] : "") ||
    env.CS_GAMEPLAY_JSON_ROOTS ||
    env.CS_GAMEPLAY_TABLE_ROOTS ||
    "";
  const roots = parsePathList(explicitValue);
  const baseRoots = roots.length ? roots : [path.join(rootDir, "gameplay-jsons")];
  return expandTableRoots(baseRoots, rootDir);
}

function getGameplayTableFileCandidates(directory, fileName, options = {}) {
  return getGameplayTableRoots(options).map((root) => path.join(root, directory, "luac", fileName));
}

function findGameplayTableFile(directory, fileName, options = {}) {
  const candidates = getGameplayTableFileCandidates(directory, fileName, options);
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0] || "";
}

function readGameplayTableRecords(directory, fileName, options = {}) {
  for (const root of getGameplayTableRoots(options)) {
    const filePath = path.join(root, directory, "luac", fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return extractTableRecords(parsed);
    } catch (err) {
      const label = options.logLabel || "gameplay-jsons";
      console.log(`[${label}] failed to load ${filePath}: ${err.message}`);
    }
  }
  return [];
}

function extractTableRecords(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];
  if (Array.isArray(parsed.records)) return parsed.records;
  if (Array.isArray(parsed.root)) return parsed.root;
  if (parsed.root && typeof parsed.root === "object") {
    return Object.values(parsed.root).filter((entry) => entry && typeof entry === "object");
  }
  return [];
}

function expandTableRoots(roots, rootDir = ROOT_DIR) {
  const seen = new Set();
  const result = [];
  for (const root of roots) {
    const resolved = path.resolve(rootDir, root);
    const basename = path.basename(resolved).toLowerCase();
    const candidates = TABLE_ROOT_NAMES.has(basename)
      ? [resolved]
      : [path.join(resolved, "Assetbundles"), path.join(resolved, "StreamingAssets")];
    for (const candidate of candidates) {
      const key = path.normalize(candidate).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(candidate);
    }
  }
  return result;
}

function parsePathList(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

module.exports = {
  DEFAULT_GAMEPLAY_TABLE_ROOT,
  expandTableRoots,
  extractTableRecords,
  findGameplayTableFile,
  getGameplayTableFileCandidates,
  getGameplayTableRoots,
  parsePathList,
  readGameplayTableRecords,
};
