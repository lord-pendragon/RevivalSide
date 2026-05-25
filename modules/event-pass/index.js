const path = require("path");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const {
  readSignedVarInt,
  writeBool,
  writeInt64LE,
  writeNullableObject,
  writeNullableObjectList,
  writeSignedVarInt,
  buildItemMiscData,
  buildRewardData,
} = require("../packet-codec");
const { createEmptyReward, grantRewardByType, mergeReward } = require("../reward");

const ROOT_DIR = path.resolve(__dirname, "..", "..");

const PACKETS = Object.freeze({
  EVENT_PASS_LEVEL_COMPLETE_REQ: 3008,
  EVENT_PASS_LEVEL_COMPLETE_ACK: 3009,
  EVENT_PASS_REQ: 3010,
  EVENT_PASS_ACK: 3011,
  EVENT_PASS_MISSION_REQ: 3012,
  EVENT_PASS_MISSION_ACK: 3013,
  EVENT_PASS_NOT: 3014,
  EVENT_PASS_FINAL_MISSION_COMPLETE_REQ: 3015,
  EVENT_PASS_FINAL_MISSION_COMPLETE_ACK: 3016,
  EVENT_PASS_DAILY_MISSION_RETRY_REQ: 3017,
  EVENT_PASS_DAILY_MISSION_RETRY_ACK: 3018,
  EVENT_PASS_PURCHASE_CORE_PASS_REQ: 3019,
  EVENT_PASS_PURCHASE_CORE_PASS_ACK: 3020,
  EVENT_PASS_PURCHASE_CORE_PASS_PLUS_REQ: 3021,
  EVENT_PASS_PURCHASE_CORE_PASS_PLUS_ACK: 3022,
  EVENT_PASS_DOT_NOT: 3023,
  EVENT_PASS_LEVEL_UP_REQ: 3024,
  EVENT_PASS_LEVEL_UP_ACK: 3025,
});

const ERROR_OK = 0;
const MISSION_TYPES = Object.freeze({
  Daily: 0,
  Weekly: 1,
});
const MISSION_TYPE_NAMES = Object.freeze(["Daily", "Weekly"]);
const GENERIC_EVENT_PASS_EXP_ID = 504;
const TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const DATE_TIME_LOCAL_MASK = 0x4000000000000000n;
const DAY_MS = 24 * 60 * 60 * 1000;
const COUNTER_PASS_NOTIFY_RETRY_MS = 1500;

let cachedTables = null;

function createEventPassHandlers() {
  const handlers = [
    [PACKETS.EVENT_PASS_REQ, "EVENT_PASS_REQ", handleEventPassReq],
    [PACKETS.EVENT_PASS_LEVEL_COMPLETE_REQ, "EVENT_PASS_LEVEL_COMPLETE_REQ", handleLevelCompleteReq],
    [PACKETS.EVENT_PASS_MISSION_REQ, "EVENT_PASS_MISSION_REQ", handleMissionReq],
    [PACKETS.EVENT_PASS_FINAL_MISSION_COMPLETE_REQ, "EVENT_PASS_FINAL_MISSION_COMPLETE_REQ", handleFinalMissionCompleteReq],
    [PACKETS.EVENT_PASS_DAILY_MISSION_RETRY_REQ, "EVENT_PASS_DAILY_MISSION_RETRY_REQ", handleDailyMissionRetryReq],
    [PACKETS.EVENT_PASS_PURCHASE_CORE_PASS_REQ, "EVENT_PASS_PURCHASE_CORE_PASS_REQ", handlePurchaseCorePassReq],
    [PACKETS.EVENT_PASS_PURCHASE_CORE_PASS_PLUS_REQ, "EVENT_PASS_PURCHASE_CORE_PASS_PLUS_REQ", handlePurchaseCorePassPlusReq],
    [PACKETS.EVENT_PASS_LEVEL_UP_REQ, "EVENT_PASS_LEVEL_UP_REQ", handleLevelUpReq],
  ];
  return handlers.map(([packetId, name, handle]) => ({
    packetId,
    name,
    handle(ctx, socket, packet) {
      return handle(ctx, socket, packet);
    },
  }));
}

function handleEventPassReq(ctx, socket, packet) {
  markCounterPassRequestSeen(socket);
  const user = getSocketUser(ctx, socket);
  const pass = resolveActiveCounterPass(ctx);
  const payload = buildEventPassAckPayload(ctx, user, pass);
  if (pass) {
    const state = ensureCounterPassState(user, pass);
    console.log(
      `[counter-pass:req] eventPassId=${pass.eventPassId} level=${getCurrentPassLevel(pass, state)} exp=${state.totalExp}`
    );
  } else {
    console.log("[counter-pass:req] no active counter pass; sending empty ACK");
  }
  send(ctx, socket, packet, PACKETS.EVENT_PASS_ACK, payload, "counter-pass");
  if (pass) sendCounterPassDotNotification(ctx, socket, user, pass, "counter-pass-dot");
  persist(ctx);
  return true;
}

function handleLevelCompleteReq(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const pass = resolveActiveCounterPass(ctx);
  const payload = buildLevelCompleteAckPayload(ctx, user, pass);
  send(ctx, socket, packet, PACKETS.EVENT_PASS_LEVEL_COMPLETE_ACK, payload, "counter-pass-level-complete");
  sendCounterPassDotNotification(ctx, socket, user, pass, "counter-pass-dot");
  persist(ctx);
  return true;
}

function handleMissionReq(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const pass = resolveActiveCounterPass(ctx);
  const missionType = decodeMissionType(ctx, packet.payload);
  const payload = buildMissionAckPayload(ctx, user, pass, missionType);
  send(ctx, socket, packet, PACKETS.EVENT_PASS_MISSION_ACK, payload, "counter-pass-mission");
  persist(ctx);
  return true;
}

function handleFinalMissionCompleteReq(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const pass = resolveActiveCounterPass(ctx);
  const missionType = decodeMissionType(ctx, packet.payload);
  const payload = buildFinalMissionCompleteAckPayload(user, pass, missionType);
  send(ctx, socket, packet, PACKETS.EVENT_PASS_FINAL_MISSION_COMPLETE_ACK, payload, "counter-pass-final-mission");
  sendCounterPassDotNotification(ctx, socket, user, pass, "counter-pass-dot");
  persist(ctx);
  return true;
}

function handleDailyMissionRetryReq(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const pass = resolveActiveCounterPass(ctx);
  const missionId = decodeSingleInt(ctx, packet.payload);
  const payload = buildDailyMissionRetryAckPayload(ctx, user, pass, missionId);
  send(ctx, socket, packet, PACKETS.EVENT_PASS_DAILY_MISSION_RETRY_ACK, payload, "counter-pass-daily-retry");
  persist(ctx);
  return true;
}

function handlePurchaseCorePassReq(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const pass = resolveActiveCounterPass(ctx);
  const state = pass ? ensureCounterPassState(user, pass) : null;
  if (state) state.isCorePassPurchased = true;
  const payload = Buffer.concat([writeSignedVarInt(ERROR_OK), writeNullableObjectList([])]);
  send(ctx, socket, packet, PACKETS.EVENT_PASS_PURCHASE_CORE_PASS_ACK, payload, "counter-pass-core-pass");
  sendCounterPassDotNotification(ctx, socket, user, pass, "counter-pass-dot");
  persist(ctx);
  return true;
}

function handlePurchaseCorePassPlusReq(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const pass = resolveActiveCounterPass(ctx);
  const state = pass ? ensureCounterPassState(user, pass) : null;
  if (state) {
    state.isCorePassPurchased = true;
    addCounterPassExp(pass, state, Number(pass.corePassPlusExp || 0) || Number(pass.passLevelUpExp || 0) || 0);
  }
  const payload = Buffer.concat([
    writeSignedVarInt(ERROR_OK),
    writeSignedVarInt(state ? state.totalExp : 0),
    writeNullableObjectList([]),
  ]);
  send(ctx, socket, packet, PACKETS.EVENT_PASS_PURCHASE_CORE_PASS_PLUS_ACK, payload, "counter-pass-core-plus");
  sendCounterPassDotNotification(ctx, socket, user, pass, "counter-pass-dot");
  persist(ctx);
  return true;
}

function handleLevelUpReq(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const pass = resolveActiveCounterPass(ctx);
  const increaseLv = Math.max(1, Number(decodeSingleInt(ctx, packet.payload) || 1) || 1);
  const state = pass ? ensureCounterPassState(user, pass) : null;
  if (state) addCounterPassExp(pass, state, increaseLv * (Number(pass.passLevelUpExp || 0) || 1000));
  const payload = Buffer.concat([
    writeSignedVarInt(ERROR_OK),
    writeSignedVarInt(state ? state.totalExp : 0),
    writeNullableObjectList([]),
  ]);
  send(ctx, socket, packet, PACKETS.EVENT_PASS_LEVEL_UP_ACK, payload, "counter-pass-level-up");
  sendCounterPassDotNotification(ctx, socket, user, pass, "counter-pass-dot");
  persist(ctx);
  return true;
}

function sendCounterPassLobbyNotifications(ctx, socket, label = "counter-pass-not", options = {}) {
  const session = socket && socket.session;
  const replay = session && session.gameReplay;
  const alreadySent = Boolean((session && session.counterPassNotSent) || (replay && replay.counterPassNotSent));
  const requestSeen = Boolean((session && session.counterPassReqSeen) || (replay && replay.counterPassReqSeen));
  if (alreadySent && (!options.resendIfNoAck || requestSeen)) return false;
  const pass = resolveActiveCounterPass(ctx);
  if (!pass || !ctx || typeof ctx.sendServerGamePacket !== "function") return false;
  console.log(
    `[counter-pass:not] eventPassId=${pass.eventPassId} window=${formatDate(pass.startDate)}..${formatDate(pass.endDate)} label=${label}${alreadySent ? " resend=1" : ""}`
  );
  ctx.sendServerGamePacket(socket, PACKETS.EVENT_PASS_NOT, buildEventPassNotPayload(pass), label);
  if (session) session.counterPassNotSent = true;
  if (replay) replay.counterPassNotSent = true;
  scheduleCounterPassNotificationRetry(ctx, socket, label);
  return true;
}

function sendCounterPassDotNotification(ctx, socket, user, pass, label = "counter-pass-dot") {
  if (!pass || !ctx || typeof ctx.sendServerGamePacket !== "function") return false;
  const state = ensureCounterPassState(user, pass);
  syncGenericMissionExp(user, state);
  ctx.sendServerGamePacket(socket, PACKETS.EVENT_PASS_DOT_NOT, buildDotPayload(user, pass, state), label);
  return true;
}

function buildEventPassAckPayload(ctx, user, pass) {
  if (!pass) {
    return Buffer.concat([
      writeSignedVarInt(ERROR_OK),
      writeSignedVarInt(0),
      writeSignedVarInt(0),
      writeSignedVarInt(0),
      writeBool(false),
    ]);
  }
  const state = ensureCounterPassState(user, pass);
  syncGenericMissionExp(user, state);
  return Buffer.concat([
    writeSignedVarInt(ERROR_OK),
    writeSignedVarInt(state.totalExp),
    writeSignedVarInt(state.rewardNormalLevel),
    writeSignedVarInt(state.rewardCoreLevel),
    writeBool(Boolean(state.isCorePassPurchased)),
  ]);
}

function buildLevelCompleteAckPayload(ctx, user, pass) {
  const reward = createEmptyReward();
  let normalLevel = 0;
  let coreLevel = 0;
  if (pass) {
    const state = ensureCounterPassState(user, pass);
    syncGenericMissionExp(user, state);
    const currentLevel = getCurrentPassLevel(pass, state);
    for (const row of getRewardRows(pass, state.rewardNormalLevel + 1, currentLevel)) {
      grantCounterPassRewardRow(ctx, user, row, "Normal", reward);
    }
    state.rewardNormalLevel = Math.max(state.rewardNormalLevel, currentLevel);
    if (state.isCorePassPurchased) {
      for (const row of getRewardRows(pass, state.rewardCoreLevel + 1, currentLevel)) {
        grantCounterPassRewardRow(ctx, user, row, "Core", reward);
      }
      state.rewardCoreLevel = Math.max(state.rewardCoreLevel, currentLevel);
    }
    normalLevel = state.rewardNormalLevel;
    coreLevel = state.rewardCoreLevel;
  }
  return Buffer.concat([
    writeSignedVarInt(ERROR_OK),
    writeSignedVarInt(normalLevel),
    writeSignedVarInt(coreLevel),
    writeNullableObject(buildRewardData(reward)),
  ]);
}

function buildMissionAckPayload(ctx, user, pass, missionType) {
  const type = normalizeMissionType(missionType);
  let state = null;
  let missionInfos = [];
  if (pass) {
    state = ensureCounterPassState(user, pass);
    missionInfos = ensureMissionInfos(ctx, user, pass, state, type);
  }
  return Buffer.concat([
    writeSignedVarInt(ERROR_OK),
    writeBool(Boolean(state && state.finalMissionCompleted[missionTypeName(type)])),
    writeSignedVarInt(type),
    writeNullableObjectList(missionInfos.map(buildEventPassMissionInfoData)),
    writeInt64LE(dateTimeBinaryForDate(nextMissionResetDate(currentServerDate(ctx), type))),
  ]);
}

function buildFinalMissionCompleteAckPayload(user, pass, missionType) {
  const type = normalizeMissionType(missionType);
  let totalExp = 0;
  if (pass) {
    const state = ensureCounterPassState(user, pass);
    const typeName = missionTypeName(type);
    const rewardExp = type === MISSION_TYPES.Weekly ? pass.weeklyMissionClearRewardExp : pass.dailyMissionClearRewardExp;
    if (!state.finalMissionCompleted[typeName]) {
      addCounterPassExp(pass, state, Number(rewardExp || 0) || 0);
      state.finalMissionCompleted[typeName] = true;
    }
    totalExp = state.totalExp;
  }
  return Buffer.concat([writeSignedVarInt(ERROR_OK), writeSignedVarInt(totalExp), writeSignedVarInt(type)]);
}

function buildDailyMissionRetryAckPayload(ctx, user, pass, missionId) {
  let missionInfo = { missionId: Number(missionId || 0) || 0, slotIndex: 1, retryCount: 0 };
  if (pass) {
    const state = ensureCounterPassState(user, pass);
    const missions = ensureMissionInfos(ctx, user, pass, state, MISSION_TYPES.Daily);
    const existing = missions.find((entry) => Number(entry.missionId) === Number(missionId));
    if (existing) {
      existing.retryCount = Number(existing.retryCount || 0) + 1;
      const replacement = findReplacementMissionId(ctx, pass, MISSION_TYPES.Daily, existing.slotIndex, missions.map((entry) => entry.missionId));
      if (replacement) existing.missionId = replacement;
      missionInfo = existing;
    }
  }
  return Buffer.concat([
    writeSignedVarInt(ERROR_OK),
    writeNullableObject(buildEventPassMissionInfoData(missionInfo)),
    writeNullableObjectList([]),
  ]);
}

function buildEventPassNotPayload(pass) {
  return writeSignedVarInt(Number(pass && pass.eventPassId) || 0);
}

function buildDotPayload(user, pass, state) {
  const currentLevel = getCurrentPassLevel(pass, state);
  const passLevelDot =
    currentLevel > Number(state.rewardNormalLevel || 0) ||
    (state.isCorePassPurchased && currentLevel > Number(state.rewardCoreLevel || 0));
  return Buffer.concat([
    writeBool(passLevelDot),
    writeBool(!state.finalMissionCompleted.Daily),
    writeBool(!state.finalMissionCompleted.Weekly),
  ]);
}

function resolveActiveCounterPass(ctx = {}) {
  const activeState =
    ctx.eventManager && typeof ctx.eventManager.getActiveEventState === "function"
      ? ctx.eventManager.getActiveEventState()
      : null;
  const summary = activeState && Array.isArray(activeState.counterPasses) ? activeState.counterPasses[0] : null;
  if (!summary || !summary.eventPassId) return null;
  const row = getTableSet().passRows.find((entry) => Number(entry.EventPassID) === Number(summary.eventPassId));
  if (!row) return null;
  return normalizePass(row, summary);
}

function normalizePass(row, summary = {}) {
  const passLevelUpExp = Number(row.PassLevelUpExp || 0) || 1000;
  const passMaxLevel = Number(row.PassMaxLevel || 0) || 50;
  const startDate = parseDate(summary.startDate || row.EventPassStartDate);
  const endDate = parseDate(summary.endDate || row.EventPassEndDate);
  return {
    eventPassId: Number(row.EventPassID || summary.eventPassId || 0) || 0,
    raw: row,
    title: String(row.EventPassTitleStrID || ""),
    eventPassMainRewardType: String(row.EventPassMainRewardType || ""),
    eventPassMainReward: Number(row.EventPassMainReward || 0) || 0,
    passMaxLevel,
    passMaxExp: Math.max(0, (passMaxLevel - 1) * passLevelUpExp),
    passLevelUpExp,
    passLevelUpMiscId: Number(row.PassLevelUpMiscID || 0) || 0,
    passLevelUpMiscCount: Number(row.PassLevelUpMiscCount || 0) || 0,
    passRewardGroupId: Number(row.PassRewardGroupID || row.EventPassID || 0) || 0,
    dailyMissionGroupId: Number(row.DailyMissionGroupID || 0) || 0,
    dailyMissionMaxSlot: Number(row.DailyMissionMaxSlot || 0) || 10,
    dailyMissionClearCount: Number(row.DailyMissionClearCount || 0) || 0,
    dailyMissionClearRewardExp: Number(row.DailyMissionClearRewardExp || 0) || 0,
    weeklyMissionGroupId: Number(row.WeeklyMissionGroupID || 0) || 0,
    weeklyMissionMaxSlot: Number(row.WeeklyMissionMaxSlot || 0) || 10,
    weeklyMissionClearCount: Number(row.WeeklyMissionClearCount || 0) || 0,
    weeklyMissionClearRewardExp: Number(row.WeeklyMissionClearRewardExp || 0) || 0,
    corePassPlusExp: Number(row.CorePassPlusExp || 0) || 0,
    dateStrId: String(row.m_DateStrID || ""),
    startDate,
    endDate,
  };
}

function ensureCounterPassState(user, pass) {
  const root = user && typeof user === "object" ? user : {};
  root.counterPass = root.counterPass && typeof root.counterPass === "object" ? root.counterPass : {};
  root.counterPass.passes = root.counterPass.passes && typeof root.counterPass.passes === "object" ? root.counterPass.passes : {};
  const key = String(Number(pass && pass.eventPassId) || 0);
  const existing = root.counterPass.passes[key] && typeof root.counterPass.passes[key] === "object" ? root.counterPass.passes[key] : {};
  const state = {
    totalExp: nonNegativeInt(existing.totalExp),
    rewardNormalLevel: nonNegativeInt(existing.rewardNormalLevel),
    rewardCoreLevel: nonNegativeInt(existing.rewardCoreLevel),
    isCorePassPurchased: Boolean(existing.isCorePassPurchased),
    genericExpSeen: existing.genericExpSeen == null ? getGenericMissionPassExp(root) : nonNegativeInt(existing.genericExpSeen),
    missions: existing.missions && typeof existing.missions === "object" ? existing.missions : {},
    missionWeeks: existing.missionWeeks && typeof existing.missionWeeks === "object" ? existing.missionWeeks : {},
    finalMissionCompleted:
      existing.finalMissionCompleted && typeof existing.finalMissionCompleted === "object"
        ? existing.finalMissionCompleted
        : {},
  };
  state.missions.Daily = Array.isArray(state.missions.Daily) ? state.missions.Daily : [];
  state.missions.Weekly = Array.isArray(state.missions.Weekly) ? state.missions.Weekly : [];
  state.finalMissionCompleted.Daily = Boolean(state.finalMissionCompleted.Daily);
  state.finalMissionCompleted.Weekly = Boolean(state.finalMissionCompleted.Weekly);
  root.counterPass.passes[key] = state;
  return state;
}

function syncGenericMissionExp(user, state) {
  if (!user || !state) return;
  const total = getGenericMissionPassExp(user);
  const seen = nonNegativeInt(state.genericExpSeen);
  if (total > seen) {
    state.totalExp = nonNegativeInt(state.totalExp) + (total - seen);
  }
  state.genericExpSeen = Math.max(total, seen);
}

function getGenericMissionPassExp(user) {
  const eventPass = user && user.eventPass && typeof user.eventPass === "object" ? user.eventPass : {};
  const generic = eventPass[String(GENERIC_EVENT_PASS_EXP_ID)] && typeof eventPass[String(GENERIC_EVENT_PASS_EXP_ID)] === "object"
    ? eventPass[String(GENERIC_EVENT_PASS_EXP_ID)]
    : {};
  return Math.max(nonNegativeInt(user && user.eventPassExp), nonNegativeInt(generic.exp));
}

function addCounterPassExp(pass, state, amount) {
  const next = nonNegativeInt(state.totalExp) + Math.max(0, Number(amount || 0) || 0);
  state.totalExp = Math.min(next, Number(pass.passMaxExp || 0) || next);
}

function getCurrentPassLevel(pass, state) {
  const expPerLevel = Math.max(1, Number(pass && pass.passLevelUpExp) || 1000);
  return Math.max(1, Math.min(Number(pass && pass.passMaxLevel) || 50, Math.floor(nonNegativeInt(state && state.totalExp) / expPerLevel) + 1));
}

function ensureMissionInfos(ctx, user, pass, state, missionType) {
  const typeName = missionTypeName(missionType);
  const week = getWeekSinceEventStart(currentServerDate(ctx), pass.startDate);
  const current = Array.isArray(state.missions[typeName]) ? state.missions[typeName] : [];
  if (current.length && Number(state.missionWeeks[typeName] || 0) === week) return current;
  const missions = buildMissionInfos(pass, missionType, week);
  state.missions[typeName] = missions;
  state.missionWeeks[typeName] = week;
  state.finalMissionCompleted[typeName] = false;
  return missions;
}

function buildMissionInfos(pass, missionType, week) {
  const groupId = missionType === MISSION_TYPES.Weekly ? pass.weeklyMissionGroupId : pass.dailyMissionGroupId;
  const maxSlot = missionType === MISSION_TYPES.Weekly ? pass.weeklyMissionMaxSlot : pass.dailyMissionMaxSlot;
  const groupRows = getMissionGroupRows(missionType, groupId, week);
  const missions = [];
  const usedMissionIds = new Set();
  const usedSlots = new Set();
  for (const row of groupRows) {
    const missionIds = normalizeIntList(row.MissionID);
    const slots = normalizeIntList(row.MissionSlotIndex);
    for (const slotIndex of slots) {
      if (missions.length >= maxSlot || usedSlots.has(slotIndex)) continue;
      const missionId = missionIds.find((id) => !usedMissionIds.has(id)) || missionIds[0] || 0;
      if (!missionId) continue;
      missions.push({ missionId, slotIndex, retryCount: 0 });
      usedMissionIds.add(missionId);
      usedSlots.add(slotIndex);
    }
  }
  return missions.sort((left, right) => left.slotIndex - right.slotIndex);
}

function getMissionGroupRows(missionType, groupId, week) {
  const rows = getTableSet().missionGroupRows.filter(
    (row) => Number(row.MissionGroupID || 0) === Number(groupId || 0) && normalizeMissionType(row.GroupEnum) === missionType
  );
  const byWeek = rows.filter((row) => normalizeIntList(row.EventMissionWeek).includes(Number(week || 1)));
  if (byWeek.length) return byWeek;
  const availableWeeks = Array.from(new Set(rows.flatMap((row) => normalizeIntList(row.EventMissionWeek)))).sort((a, b) => a - b);
  const fallbackWeek = availableWeeks[availableWeeks.length - 1] || 0;
  return fallbackWeek ? rows.filter((row) => normalizeIntList(row.EventMissionWeek).includes(fallbackWeek)) : rows;
}

function findReplacementMissionId(ctx, pass, missionType, slotIndex, usedMissionIds) {
  const groupId = missionType === MISSION_TYPES.Weekly ? pass.weeklyMissionGroupId : pass.dailyMissionGroupId;
  const week = getWeekSinceEventStart(currentServerDate(ctx), pass.startDate);
  const used = new Set(usedMissionIds.map(Number));
  for (const row of getMissionGroupRows(missionType, groupId, week)) {
    if (!normalizeIntList(row.MissionSlotIndex).includes(Number(slotIndex))) continue;
    const replacement = normalizeIntList(row.MissionID).find((missionId) => !used.has(missionId));
    if (replacement) return replacement;
  }
  return 0;
}

function getRewardRows(pass, fromLevel, toLevel) {
  const groupId = Number(pass && pass.passRewardGroupId) || 0;
  return getTableSet().rewardRows
    .filter((row) => Number(row.PassRewardGroupID || 0) === groupId)
    .filter((row) => Number(row.PassLevel || 0) >= Number(fromLevel || 0) && Number(row.PassLevel || 0) <= Number(toLevel || 0))
    .sort((left, right) => Number(left.PassLevel || 0) - Number(right.PassLevel || 0));
}

function grantCounterPassRewardRow(ctx, user, row, lane, reward) {
  const prefix = lane === "Core" ? "Core" : "Normal";
  const type = row[`${prefix}RewardItemType`];
  const id = Number(row[`${prefix}RewardItemID`] || 0) || 0;
  const count = Number(row[`${prefix}RewardItemCount`] || 0) || 0;
  if (!type || String(type) === "RT_NONE" || id <= 0 || count <= 0) return;
  mergeReward(
    reward,
    grantRewardByType(ctx, user, type, id, count, count, 0, {
      regDate: ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : dateTimeBinaryForDate(currentServerDate(ctx)),
      expandPackages: true,
    })
  );
}

function buildEventPassMissionInfoData(info) {
  const data = info || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.missionId || 0) || 0),
    writeSignedVarInt(Number(data.slotIndex || 0) || 0),
    writeSignedVarInt(Number(data.retryCount || 0) || 0),
  ]);
}

function getTableSet() {
  if (cachedTables) return cachedTables;
  cachedTables = {
    passRows: readRecords("ab_script", "LUA_EVENT_PASS_TEMPLET.json"),
    missionGroupRows: readRecords("ab_script", "LUA_EVENT_PASS_MISSION_GROUP_TEMPLET.json"),
    rewardRows: readRecords("ab_script", "LUA_EVENT_PASS_REWARD_TEMPLET.json"),
  };
  return cachedTables;
}

function readRecords(directory, fileName) {
  return readGameplayTableRecords(directory, fileName, { rootDir: ROOT_DIR, logLabel: "counter-pass" });
}

function decodeMissionType(ctx, encryptedPayload) {
  return normalizeMissionType(decodeSingleInt(ctx, encryptedPayload));
}

function decodeSingleInt(ctx, encryptedPayload) {
  try {
    const payload = ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(encryptedPayload) : Buffer.alloc(0);
    return readSignedVarInt(payload, 0).value;
  } catch (_) {
    return 0;
  }
}

function normalizeMissionType(value) {
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "weekly" || text === "1") return MISSION_TYPES.Weekly;
    return MISSION_TYPES.Daily;
  }
  return Number(value) === MISSION_TYPES.Weekly ? MISSION_TYPES.Weekly : MISSION_TYPES.Daily;
}

function missionTypeName(value) {
  return MISSION_TYPE_NAMES[normalizeMissionType(value)] || "Daily";
}

function getWeekSinceEventStart(current, startDate) {
  const start = startDate instanceof Date && !Number.isNaN(startDate.getTime()) ? startDate : current;
  const timeSpan = current.getTime() - start.getTime();
  if (timeSpan <= 0) return 1;
  const totalDays = Math.floor(timeSpan / DAY_MS);
  let week = Math.floor(totalDays / 7);
  const dayRemainder = totalDays % 7;
  let currentDayFromMonday = current.getUTCDay() - 1;
  if (currentDayFromMonday < 0) currentDayFromMonday += 7;
  if (dayRemainder >= currentDayFromMonday) week += 1;
  if (start.getUTCDay() !== 1) week += 1;
  return Math.max(1, week);
}

function nextMissionResetDate(date, missionType) {
  const current = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  if (missionType === MISSION_TYPES.Weekly) {
    const day = current.getUTCDay();
    const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
    return new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + daysUntilMonday, 4, 0, 0, 0));
  }
  return new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1, 4, 0, 0, 0));
}

function currentServerDate(ctx) {
  if (ctx && typeof ctx.getServerNowDate === "function") {
    const date = ctx.getServerNowDate();
    if (date instanceof Date && !Number.isNaN(date.getTime())) return date;
  }
  const date = ctx && ctx.eventManager && ctx.eventManager.config ? ctx.eventManager.config.eventDate : null;
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
}

function dateTimeBinaryForDate(date) {
  const source = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return BigInt(source.getTime()) * 10000n + TICKS_AT_UNIX_EPOCH | DATE_TIME_LOCAL_MASK;
}

function parseDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeIntList(value) {
  if (Array.isArray(value)) return value.map(Number).filter((entry) => Number.isInteger(entry) && entry > 0);
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? [number] : [];
}

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function getSocketUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  return ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
}

function markCounterPassRequestSeen(socket) {
  const session = socket && socket.session;
  const replay = session && session.gameReplay;
  if (session) session.counterPassReqSeen = true;
  if (replay) replay.counterPassReqSeen = true;
}

function scheduleCounterPassNotificationRetry(ctx, socket, label) {
  const session = socket && socket.session;
  if (!session || session.counterPassNotRetryScheduled) return;
  session.counterPassNotRetryScheduled = true;

  const timer = setTimeout(() => {
    const replay = session.gameReplay;
    const requestSeen = Boolean(session.counterPassReqSeen || (replay && replay.counterPassReqSeen));
    if (requestSeen) return;
    if (!socket || socket.destroyed || socket.writableEnded) {
      console.log("[counter-pass:not] no EVENT_PASS_REQ after notify; socket closed before retry");
      return;
    }
    console.log("[counter-pass:not] no EVENT_PASS_REQ after notify; retrying");
    sendCounterPassLobbyNotifications(ctx, socket, `${label}-retry`, { resendIfNoAck: true });
  }, COUNTER_PASS_NOTIFY_RETRY_MS);

  if (typeof timer.unref === "function") timer.unref();
}

function formatDate(date) {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : "n/a";
}

function send(ctx, socket, packet, packetId, payload, label) {
  if (ctx && typeof ctx.sendGameResponse === "function") {
    ctx.sendGameResponse(socket, packet, packetId, payload, label);
  }
}

function persist(ctx) {
  if (ctx && (!ctx.config || ctx.config.USE_LOCAL_USER_DB) && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

module.exports = {
  PACKETS,
  createEventPassHandlers,
  resolveActiveCounterPass,
  sendCounterPassLobbyNotifications,
  buildEventPassAckPayload,
  buildMissionAckPayload,
  buildEventPassNotPayload,
};
