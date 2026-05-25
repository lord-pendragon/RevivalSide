// Battle state ownership.
//
// This module keeps the small bits of combat metadata that Node still needs for
// managed combat bookkeeping. It intentionally does not send network packets or
// own battle simulation.

function createBattleStateManager(options = {}) {
  const tick = options.tick;
  const extractGameLoadUnitPools = options.extractGameLoadUnitPools || (() => emptyPools());
  const capturedRespawnUnitPools = options.capturedRespawnUnitPools || emptyPools();
  const parseCapturedGameSyncPayload = options.parseCapturedGameSyncPayload;
  const capturedGameFlow = options.capturedGameFlow || null;

  function attachGameLoadUnitPools(replay, activeStage, gameLoadAckPayload) {
    if (!replay || !replay.dynamicGame) return emptyPools();
    replay.dynamicGame.unitPools = buildRuntimeGameUnitPools(activeStage || {}, gameLoadAckPayload);
    replay.dynamicGame.usedPooledGameUnitUIDs = new Set((replay.battleState.units || []).map((unit) => Number(unit.gameUnitUID || 0)));
    return replay.dynamicGame.unitPools;
  }

  function buildRuntimeGameUnitPools(activeStage, gameLoadAckPayload) {
    const pools = extractGameLoadUnitPools(gameLoadAckPayload);
    mergeExtractedUnitPools(pools, capturedRespawnUnitPools);

    for (const unit of activeStage.autoDeployUnits || []) {
      mergeExtractedUnitPools(pools, {
        unitUID: unit.unitUID,
        gameUnitUIDs: unit.gameUnitUIDs || [],
      });
    }

    const fallbackUIDs = new Set(pools.allGameUnitUIDs);
    for (const group of activeStage.deployableGameUnitUIDGroups || []) {
      for (const uid of group || []) {
        const numeric = Number(uid);
        if (Number.isInteger(numeric) && numeric > 0) fallbackUIDs.add(numeric);
      }
    }
    pools.unassignedGameUnitUIDs = Array.from(fallbackUIDs).filter((uid) => uid > 4).sort((a, b) => a - b);
    return pools;
  }

  function describeRuntimeGameUnitPools(pools) {
    if (!pools || !pools.ordered || pools.ordered.length === 0) return "";
    return pools.ordered.map((pool) => `${pool.unitUID}:${pool.gameUnitUIDs.join("/")}`).join(";");
  }

  function transitionTutorialReplayToDynamic(replay, endIndex) {
    if (!replay || !replay.tutorialReplayPhase || replay.tutorialReplayPhase === "dynamic") return false;
    const capturedState = extractCapturedBattleStateBeforeIndex(endIndex);
    replay.tutorialReplayPhase = "dynamic";
    if (replay.dynamicGame) replay.dynamicGame.initialUnitsSent = true;
    if (replay.battleState && capturedState.units.length > 0) {
      replay.battleState.units = mergeCapturedBattleUnits(capturedState.units, replay.battleState.units, replay);
      replay.battleState.gameTime = capturedState.gameTime;
      replay.battleState.absoluteGameTime = capturedState.absoluteGameTime;
      replay.battleState.remainGameTime = capturedState.remainGameTime;
      replay.battleState.continuationMode = true;
      replay.battleState.pendingDieUnitUIDs = [];
    } else if (replay.battleState) {
      replay.battleState.gameTime = Math.max(Number(replay.battleState.gameTime || 0), Number(replay.syntheticGameTime || 0), 14);
      replay.battleState.absoluteGameTime = Math.max(Number(replay.battleState.absoluteGameTime || 0), replay.battleState.gameTime);
      replay.battleState.continuationMode = true;
      replay.battleState.pendingDieUnitUIDs = replay.battleState.pendingDieUnitUIDs || [];
    }
    return true;
  }

  function mergeCapturedBattleUnits(capturedUnits, previousUnits, replay) {
    const previousByUid = new Map();
    for (const unit of previousUnits || []) {
      if (!unit || unit.gameUnitUID == null) continue;
      previousByUid.set(Number(unit.gameUnitUID), unit);
    }
    return capturedUnits.map((unit) => {
      const previous = previousByUid.get(Number(unit.gameUnitUID)) || {};
      const merged = {
        ...previous,
        ...unit,
        role: unit.role || previous.role || "",
        unitID: unit.unitID || previous.unitID || previous.baseUnitID || 0,
        unitStrID: unit.unitStrID || previous.unitStrID || "",
        sourceUnitUID: unit.sourceUnitUID || previous.sourceUnitUID || "",
        maxHp: Math.max(1, Number(previous.maxHp || 0), Number(unit.maxHp || 0), Number(unit.hp || 0)),
        pendingRemove: false,
        deadTicks: 0,
      };
      if (!merged.sourceUnitUID && replay && replay.lastRespawnReq && merged.team === 1 && Number(merged.gameUnitUID) > 4) {
        merged.sourceUnitUID = replay.lastRespawnReq.unitUID;
      }
      tick.hydrateBattleUnitStats(merged);
      return merged;
    });
  }

  function extractCapturedBattleStateBeforeIndex(endIndex) {
    const latestUnits = new Map();
    let gameTime = 14;
    let absoluteGameTime = 14;
    let remainGameTime = 166;
    if (!capturedGameFlow || !Array.isArray(capturedGameFlow.server) || typeof parseCapturedGameSyncPayload !== "function") {
      return { units: [], gameTime, absoluteGameTime, remainGameTime };
    }

    const limit = Math.min(Math.max(1, Number(endIndex || 1)) - 1, capturedGameFlow.server.length);
    for (let index = 1; index <= limit; index += 1) {
      const entry = capturedGameFlow.server[index - 1];
      if (!entry || entry.packetId !== 822 || !entry.payload) continue;
      try {
        const sync = parseCapturedGameSyncPayload(entry);
        gameTime = Math.max(gameTime, sync.gameTime || 0);
        absoluteGameTime = Math.max(absoluteGameTime, sync.absoluteGameTime || gameTime);
        if (sync.remainGameTime != null) remainGameTime = sync.remainGameTime;
        for (const unit of sync.units) {
          latestUnits.set(unit.gameUnitUID, {
            ...(latestUnits.get(unit.gameUnitUID) || {}),
            ...unit,
            respawn: false,
            continuation: true,
          });
        }
      } catch (_) {
        // Lightweight sync parsing is best-effort; failed nested payloads stay on captured replay.
      }
    }

    return {
      units: Array.from(latestUnits.values()).sort((a, b) => a.gameUnitUID - b.gameUnitUID),
      gameTime,
      absoluteGameTime,
      remainGameTime,
    };
  }

  return {
    attachGameLoadUnitPools,
    buildRuntimeGameUnitPools,
    describeRuntimeGameUnitPools,
    transitionTutorialReplayToDynamic,
    mergeCapturedBattleUnits,
    extractCapturedBattleStateBeforeIndex,
  };
}

function emptyPools() {
  return { byUnitUID: new Map(), ordered: [], allGameUnitUIDs: [], unassignedGameUnitUIDs: [] };
}

function buildCapturedRespawnUnitPools(flow, options = {}) {
  const byUnitUID = new Map();
  const ordered = [];
  const decodeGameRespawnReq = options.decodeGameRespawnReq;
  const parseCapturedGameSyncPayload = options.parseCapturedGameSyncPayload;
  const gameRespawnAck = options.gameRespawnAck || 817;
  const gameSync = options.gameSync || 822;
  if (
    !flow ||
    !Array.isArray(flow.client) ||
    !Array.isArray(flow.server) ||
    typeof decodeGameRespawnReq !== "function" ||
    typeof parseCapturedGameSyncPayload !== "function"
  ) {
    return { byUnitUID, ordered };
  }

  const requests = flow.client
    .filter((entry) => entry && entry.packetId === 816 && entry.payload)
    .map((entry) => {
      const req = decodeGameRespawnReq(entry.payload);
      return req ? { ...req, time: Number(entry.time || 0), sequence: entry.sequence || entry.seq || 0 } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);

  for (let reqIndex = 0; reqIndex < requests.length; reqIndex += 1) {
    const req = requests[reqIndex];
    const nextReq = requests[reqIndex + 1];
    const ack = flow.server.find(
      (entry) =>
        entry &&
        entry.packetId === gameRespawnAck &&
        Number(entry.time || 0) >= req.time &&
        (!nextReq || Number(entry.time || 0) < nextReq.time)
    );
    const startTime = ack ? Number(ack.time || req.time) : req.time;
    const endTime = nextReq ? nextReq.time : Infinity;
    const gameUnitUIDs = [];
    const seen = new Set();
    for (const entry of flow.server) {
      if (!entry || entry.packetId !== gameSync || !entry.payload) continue;
      const entryTime = Number(entry.time || 0);
      if (entryTime < startTime || entryTime >= endTime) continue;
      try {
        const sync = parseCapturedGameSyncPayload(entry);
        for (const unit of sync.units || []) {
          const uid = Number(unit.gameUnitUID || 0);
          if (!unit.respawn || uid <= 4 || unit.team !== 1 || seen.has(uid)) continue;
          seen.add(uid);
          gameUnitUIDs.push(uid);
        }
      } catch (_) {
        // Some 822 packets contain nested fields this lightweight parser intentionally skips.
      }
    }
    if (gameUnitUIDs.length > 0) {
      const pool = { unitUID: String(req.unitUID), gameUnitUIDs, cursor: 0 };
      byUnitUID.set(pool.unitUID, pool);
      ordered.push(pool);
    }
  }

  return { byUnitUID, ordered };
}

function mergeExtractedUnitPools(target, source, team) {
  if (!target || !source) return;
  const entries = source.ordered
    ? source.ordered
    : source.gameUnitUIDs
      ? [{ unitUID: String(source.unitUID || ""), unitID: source.unitID || 0, gameUnitUIDs: source.gameUnitUIDs }]
      : [];
  if (!target.byUnitUID) target.byUnitUID = new Map();
  if (!target.ordered) target.ordered = [];
  if (!target.allGameUnitUIDs) target.allGameUnitUIDs = [];
  for (const entry of entries) {
    const gameUnitUIDs = (entry.gameUnitUIDs || []).map(Number).filter((value) => Number.isInteger(value) && value > 0);
    for (const uid of gameUnitUIDs) {
      if (!target.allGameUnitUIDs.includes(uid)) target.allGameUnitUIDs.push(uid);
    }
    if (!entry.unitUID || gameUnitUIDs.length === 0) continue;
    const key = String(entry.unitUID);
    if (!target.byUnitUID.has(key)) {
      target.byUnitUID.set(key, { unitUID: key, unitID: entry.unitID || 0, team, gameUnitUIDs: [], cursor: 0 });
      target.ordered.push(target.byUnitUID.get(key));
    }
    const pool = target.byUnitUID.get(key);
    for (const uid of gameUnitUIDs) {
      if (!pool.gameUnitUIDs.includes(uid)) pool.gameUnitUIDs.push(uid);
    }
  }
}

module.exports = {
  createBattleStateManager,
  buildCapturedRespawnUnitPools,
  emptyPools,
  mergeExtractedUnitPools,
};
