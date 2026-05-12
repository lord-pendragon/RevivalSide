const fs = require("fs");
const path = require("path");

const { dateTimeBinaryNow } = require("../packet-codec");
const {
  getPlayableUnitIds,
  getPlayableShipIds,
  getPlayableOperatorIds,
  getTrophyUnitIds,
} = require("../game-data");
const {
  ensureArmy,
  ensureDefaultLineup,
  getArmyUnits,
  getArmyShips,
  getArmyOperators,
  getArmyTrophies,
  grantUnit,
  grantOperator,
} = require("../unit");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS_PATH = path.join(ROOT_DIR, "gameplay-jsons", "new-account-defaults.json");
const BOOTSTRAP_KEY = "officialNewAccountDefaultsV1";

let cachedDefaults = null;

function ensureOfficialNewAccountDefaults(user, options = {}) {
  const result = {
    changed: false,
    units: 0,
    ships: 0,
    operators: 0,
    trophies: 0,
  };
  if (!user || typeof user !== "object") return result;

  if (applyOfficialProfileDefaults(user)) result.changed = true;

  if (options.seedRoster === false) {
    rememberBootstrap(user, result, { rosterSeeded: false });
    return result;
  }

  const seeded = seedOfficialRoster(user, {
    includeTrophies: options.includeTrophies === true,
  });
  Object.assign(result, seeded, { changed: result.changed || seeded.changed });

  ensureDefaultLineup(user);
  ensureDefaultLineup(user, { deckType: 3, index: 0 });
  rememberBootstrap(user, result, { rosterSeeded: true });
  return result;
}

function applyOfficialProfileDefaults(user) {
  const defaults = loadNewAccountDefaults();
  const profile = defaults.profile || {};
  const userDefaults = defaults.user || {};
  let changed = false;

  changed = setMissing(user, "level", Number(userDefaults.level || 1)) || changed;
  changed = setMissing(user, "exp", String(userDefaults.exp || "0")) || changed;
  changed = setMissing(user, "totalExp", String(userDefaults.totalExp || "0")) || changed;
  changed = setMissing(user, "friendIntro", String(profile.friendIntro || "")) || changed;
  changed = setMissing(user, "mainUnitId", Number(profile.mainUnitId || 0)) || changed;
  changed = setMissing(user, "mainUnitSkinId", Number(profile.mainUnitSkinId || 0)) || changed;
  changed = setMissing(user, "mainUnitTacticLevel", Number(profile.mainUnitTacticLevel || 0)) || changed;
  changed = setMissing(user, "frameId", Number(profile.frameId || 0)) || changed;
  changed = setMissing(user, "selfiFrameId", Number(profile.selfiFrameId || 0)) || changed;
  changed = setMissing(user, "titleId", Number(profile.titleId || 0)) || changed;
  return changed;
}

function seedOfficialRoster(user, options = {}) {
  ensureArmy(user);
  const result = {
    changed: false,
    units: seedUnitBucket(user, getPlayableUnitIds(), getArmyUnits(user), grantUnit),
    ships: seedUnitBucket(user, getPlayableShipIds(), getArmyShips(user), grantUnit),
    operators: seedUnitBucket(user, getPlayableOperatorIds(), getArmyOperators(user), grantOperator),
    trophies: options.includeTrophies
      ? seedUnitBucket(user, getTrophyUnitIds(), getArmyTrophies(user), grantUnit)
      : 0,
  };
  result.changed = result.units > 0 || result.ships > 0 || result.operators > 0 || result.trophies > 0;
  return result;
}

function seedUnitBucket(user, ids, existingEntries, grant) {
  const ownedIds = new Set(
    (Array.isArray(existingEntries) ? existingEntries : [])
      .map((entry) => Number(entry && (entry.unitId || entry.id) || 0))
      .filter((id) => Number.isInteger(id) && id > 0)
  );
  let granted = 0;
  const regDate = dateTimeBinaryNow();
  for (const id of Array.isArray(ids) ? ids : []) {
    const unitId = Number(id || 0);
    if (!Number.isInteger(unitId) || unitId <= 0 || ownedIds.has(unitId)) continue;
    const entry = grant(user, unitId, {
      level: 1,
      exp: 0,
      regDate,
      fromContract: true,
    });
    if (!entry) continue;
    ownedIds.add(unitId);
    granted += 1;
  }
  return granted;
}

function rememberBootstrap(user, result, options = {}) {
  user.bootstrap = user.bootstrap && typeof user.bootstrap === "object" ? user.bootstrap : {};
  user.bootstrap[BOOTSTRAP_KEY] = {
    appliedAt: new Date().toISOString(),
    rosterSeeded: options.rosterSeeded === true,
    units: Number(result.units || 0),
    ships: Number(result.ships || 0),
    operators: Number(result.operators || 0),
    trophies: Number(result.trophies || 0),
  };
}

function loadNewAccountDefaults() {
  if (cachedDefaults) return cachedDefaults;
  try {
    const parsed = JSON.parse(fs.readFileSync(DEFAULTS_PATH, "utf8"));
    cachedDefaults = parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    cachedDefaults = {};
  }
  return cachedDefaults;
}

function setMissing(target, key, value) {
  if (target[key] !== undefined && target[key] !== null) return false;
  target[key] = value;
  return true;
}

module.exports = {
  ensureOfficialNewAccountDefaults,
};
