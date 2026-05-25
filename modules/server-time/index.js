const fs = require("fs");
const path = require("path");

const STATE_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

function createServerTime(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.resolve(__dirname, "..", ".."));
  const statePath = path.resolve(options.statePath || path.join(rootDir, "server-data", "server-time.json"));
  const eventManager = options.eventManager || null;
  const logger = typeof options.logger === "function" ? options.logger : null;
  let state = loadState(statePath, logger);

  function now(localNowInput = new Date()) {
    const localNow = validDate(localNowInput) || new Date();
    const eventDate = getConfiguredEventDate(eventManager);
    if (!eventDate) return new Date(localNow.getTime());

    const eventDateKey = utcDateKey(eventDate);
    const localDayKeyValue = localDayKey(localNow);
    let changed = false;

    if (!isUsableState(state) || state.eventDateKey !== eventDateKey) {
      state = createAnchoredState(eventDateKey, localDayKeyValue);
      changed = true;
    }

    const elapsedDays = Math.max(0, daysBetweenDateKeys(state.anchorLocalDayKey, localDayKeyValue));
    let serverDateKey = addDaysToDateKey(state.anchorServerDateKey, elapsedDays);
    if (isDateKey(state.lastServerDateKey) && compareDateKeys(serverDateKey, state.lastServerDateKey) < 0) {
      serverDateKey = state.lastServerDateKey;
    }

    if (state.lastLocalDayKey !== localDayKeyValue || state.lastServerDateKey !== serverDateKey) {
      state.lastLocalDayKey = localDayKeyValue;
      state.lastServerDateKey = serverDateKey;
      state.updatedAt = new Date().toISOString();
      changed = true;
    }

    if (changed) saveState(statePath, state, logger);
    return combineUtcDateWithLocalTime(serverDateKey, localNow);
  }

  function getSummary() {
    const current = now();
    const eventDate = getConfiguredEventDate(eventManager);
    return {
      enabled: Boolean(eventDate),
      statePath,
      currentIso: current.toISOString(),
      eventDateKey: eventDate ? utcDateKey(eventDate) : "",
      state: { ...state },
    };
  }

  return {
    now,
    getSummary,
    getState() {
      return { ...state };
    },
  };
}

function getConfiguredEventDate(eventManager) {
  const config = eventManager && eventManager.config;
  if (!config || !config.enabled) return null;
  return validDate(config.eventDate);
}

function createAnchoredState(eventDateKey, localDayKeyValue) {
  return {
    version: STATE_VERSION,
    eventDateKey,
    anchorServerDateKey: eventDateKey,
    anchorLocalDayKey: localDayKeyValue,
    lastLocalDayKey: localDayKeyValue,
    lastServerDateKey: eventDateKey,
    updatedAt: new Date().toISOString(),
  };
}

function isUsableState(value) {
  return (
    value &&
    typeof value === "object" &&
    Number(value.version || 0) === STATE_VERSION &&
    isDateKey(value.eventDateKey) &&
    isDateKey(value.anchorServerDateKey) &&
    isDateKey(value.anchorLocalDayKey)
  );
}

function loadState(statePath, logger) {
  try {
    if (!statePath || !fs.existsSync(statePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (logger) logger(`[server-time] failed to read ${statePath}: ${error.message}`);
    return {};
  }
}

function saveState(statePath, state, logger) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmpPath = `${statePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, statePath);
  } catch (error) {
    if (logger) logger(`[server-time] failed to save ${statePath}: ${error.message}`);
  }
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function utcDateKey(date) {
  const source = validDate(date) || new Date();
  return [
    source.getUTCFullYear(),
    pad2(source.getUTCMonth() + 1),
    pad2(source.getUTCDate()),
  ].join("-");
}

function localDayKey(date) {
  const source = validDate(date) || new Date();
  return [source.getFullYear(), pad2(source.getMonth() + 1), pad2(source.getDate())].join("-");
}

function daysBetweenDateKeys(startKey, endKey) {
  const start = dateKeyToUtcMs(startKey);
  const end = dateKeyToUtcMs(endKey);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.trunc((end - start) / DAY_MS);
}

function addDaysToDateKey(dateKey, days) {
  const ms = dateKeyToUtcMs(dateKey);
  if (!Number.isFinite(ms)) return dateKey;
  return utcDateKey(new Date(ms + Math.trunc(Number(days) || 0) * DAY_MS));
}

function compareDateKeys(left, right) {
  const leftMs = dateKeyToUtcMs(left);
  const rightMs = dateKeyToUtcMs(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return 0;
  return leftMs === rightMs ? 0 : leftMs < rightMs ? -1 : 1;
}

function dateKeyToUtcMs(dateKey) {
  const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return Number.NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return Number.NaN;
  }
  return date.getTime();
}

function combineUtcDateWithLocalTime(dateKey, localNow) {
  const ms = dateKeyToUtcMs(dateKey);
  const source = validDate(localNow) || new Date();
  if (!Number.isFinite(ms)) return new Date(source.getTime());
  const date = new Date(ms);
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      source.getHours(),
      source.getMinutes(),
      source.getSeconds(),
      source.getMilliseconds()
    )
  );
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

module.exports = {
  createServerTime,
};
