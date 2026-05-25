// Managed deployment helpers for GAME_RESPAWN_REQ (816).
//
// The C# host owns packet emission. This module only mirrors runtime unit
// metadata into battleState so result/reward bookkeeping can read it later.

function createDeployHandler(options = {}) {
  const tick = options.tick;
  const defaultDeployedUnitHp = options.defaultDeployedUnitHp || 1989;
  const combatStateId = options.combatStateId || { IDLE: 12, MOVE: 13, ATTACK: 45, DEAD: 18 };

  function deployRuntimeBattleUnit(replay, req) {
    const battleState = replay && replay.battleState;
    if (!battleState || !req) return null;
    const pooled = consumePooledGameUnitUIDForDeploy(replay, req.unitUID);
    if (!pooled) return null;
    const deckUnit = findPlayerDeckUnit(replay, req.unitUID);
    const gameUnitUID = pooled.gameUnitUID;
    const unitStats = tick.findGameplayUnitStats({
      unitID: pooled.unitID || (deckUnit && deckUnit.unitId) || req.unitID,
      unitStrID: req.unitStrID,
    });
    const hp = Math.max(1, Number(req.hp || (unitStats && unitStats.hp) || defaultDeployedUnitHp));
    const x = tick.clamp(Number(req.respawnPosX || 0), -3000, 3000);
    const unit = {
      sourceUnitUID: req.unitUID,
      unitID: pooled.unitID || (deckUnit && deckUnit.unitId) || req.unitID || 0,
      unitStrID: req.unitStrID || "",
      gameUnitUID,
      team: 1,
      hp,
      maxHp: hp,
      x,
      z: 0,
      savedPosX: x,
      right: true,
      playState: 1,
      respawn: true,
      stateId: combatStateId.IDLE,
      stateChangeCount: 1,
      speedX: 0,
      speedY: 0,
      speedZ: 0,
      targetUID: 0,
      subTargetUID: 0,
      seed: 51 + (gameUnitUID % 40),
      attackTimer: 0,
      deadTicks: 0,
      pendingRemove: false,
    };
    applyPlayerDeckMetadata(unit, deckUnit || pooled.pool);
    tick.hydrateBattleUnitStats(unit);
    battleState.units.push(unit);
    battleState.gameTime = Math.max(Number(battleState.gameTime || 0), Number(req.gameTime || 0));
    battleState.absoluteGameTime = Math.max(Number(battleState.absoluteGameTime || battleState.gameTime), battleState.gameTime);
    if (!Array.isArray(battleState.pendingDieUnitUIDs)) battleState.pendingDieUnitUIDs = [];
    if (!Array.isArray(battleState.pendingDeckSyncs)) battleState.pendingDeckSyncs = [];
    battleState.pendingDeckSyncs.push({
      team: 1,
      unitDeckIndex: nextDeckSyncIndexForBattleState(battleState),
      unitDeckUID: req.unitUID,
      deckUsedAddUnitUID: req.unitUID,
    });
    return unit;
  }

  function enrichBattleStateUnitsFromPlayerDeck(replay) {
    const battleState = replay && replay.battleState;
    if (!battleState || !Array.isArray(battleState.units)) return;
    for (const unit of battleState.units) {
      const deckUnit = findPlayerDeckUnit(replay, unit && unit.sourceUnitUID);
      applyPlayerDeckMetadata(unit, deckUnit || findUnitPoolForBattleUnit(replay, unit));
    }
  }

  function findPlayerDeckUnit(replay, unitUID) {
    const key = String(unitUID || "");
    if (!key) return null;
    const units =
      replay &&
      replay.dynamicGame &&
      replay.dynamicGame.playerDeck &&
      Array.isArray(replay.dynamicGame.playerDeck.units)
        ? replay.dynamicGame.playerDeck.units
        : [];
    return units.find((unit) => String(unit && (unit.unitUid || unit.unitUID || unit.UnitUid || "")) === key) || null;
  }

  function findUnitPoolForBattleUnit(replay, unit) {
    const dynamicGame = replay && replay.dynamicGame;
    const pools = dynamicGame && dynamicGame.unitPools;
    const ordered = pools && (Array.isArray(pools.ordered) ? pools.ordered : Array.isArray(pools.Ordered) ? pools.Ordered : []);
    const sourceUnitUID = String((unit && unit.sourceUnitUID) || "");
    const gameUnitUID = Number(unit && unit.gameUnitUID);
    return (
      ordered.find((pool) => sourceUnitUID && String(pool.unitUID || pool.UnitUID || "") === sourceUnitUID) ||
      ordered.find((pool) => {
        const gameUnitUIDs = pool.gameUnitUIDs || pool.GameUnitUIDs || [];
        return gameUnitUIDs.map(Number).includes(gameUnitUID);
      }) ||
      null
    );
  }

  function applyPlayerDeckMetadata(unit, source) {
    if (!unit || !source) return unit;
    const previousTacticLevel = readNumber(unit.tacticLevel, unit.TacticLevel, 0);
    const previousTacticGroup = readNumber(unit.tacticGroup, unit.TacticGroup, 0);
    const unitId = readNumber(source.unitId, source.unitID, source.UnitID, 0);
    if (unitId > 0 && !unit.unitID) unit.unitID = unitId;
    unit.limitBreakLevel = readNumber(source.limitBreakLevel, source.LimitBreakLevel, unit.limitBreakLevel, 0);
    unit.tacticLevel = readNumber(source.tacticLevel, source.TacticLevel, unit.tacticLevel, 0);
    unit.tacticGroup = readNumber(source.tacticGroup, source.TacticGroup, unit.tacticGroup, 0);
    unit.cost = readNumber(source.cost, source.deployCost, source.Cost, source.DeployCost, unit.cost, 0);
    const skillLevels = source.skillLevels || source.SkillLevels;
    if (Array.isArray(skillLevels)) unit.skillLevels = skillLevels.map(Number);
    unit.sourceUnitID = unit.unitID || unit.sourceUnitID || 0;
    if (unit.combatStats && (previousTacticLevel !== unit.tacticLevel || previousTacticGroup !== unit.tacticGroup)) {
      delete unit.combatStats;
    }
    return unit;
  }

  function readNumber(...values) {
    for (const value of values) {
      if (value == null || value === "") continue;
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return 0;
  }

  function consumePooledGameUnitUIDForDeploy(replay, unitUID) {
    const battleState = replay && replay.battleState;
    const dynamicGame = replay && replay.dynamicGame;
    const pools = dynamicGame && dynamicGame.unitPools;
    if (!battleState || !dynamicGame || !pools) return null;

    if (!dynamicGame.usedPooledGameUnitUIDs) dynamicGame.usedPooledGameUnitUIDs = new Set();
    const used = new Set([
      ...Array.from(dynamicGame.usedPooledGameUnitUIDs),
      ...battleState.units.map((unit) => Number(unit.gameUnitUID || 0)),
    ]);
    const key = String(unitUID || "");
    const preferred = pools.byUnitUID && pools.byUnitUID.get(key);
    const candidates = preferred ? [preferred] : pools.ordered || [];

    for (const pool of candidates) {
      for (const gameUnitUID of pool.gameUnitUIDs || []) {
        const numeric = Number(gameUnitUID);
        if (!Number.isInteger(numeric) || numeric <= 0 || used.has(numeric)) continue;
        dynamicGame.usedPooledGameUnitUIDs.add(numeric);
        return { gameUnitUID: numeric, unitID: pool.unitID || 0, pool };
      }
    }

    for (const gameUnitUID of pools.unassignedGameUnitUIDs || []) {
      const numeric = Number(gameUnitUID);
      if (!Number.isInteger(numeric) || numeric <= 0 || used.has(numeric)) continue;
      dynamicGame.usedPooledGameUnitUIDs.add(numeric);
      return { gameUnitUID: numeric, unitID: 0, pool: null };
    }
    return null;
  }

  function nextDeckSyncIndexForBattleState(battleState) {
    const count = Number(battleState.deployCount || 0);
    battleState.deployCount = count + 1;
    return count % 4;
  }

  return {
    deployRuntimeBattleUnit,
    enrichBattleStateUnitsFromPlayerDeck,
    consumePooledGameUnitUIDForDeploy,
    nextDeckSyncIndexForBattleState,
  };
}

module.exports = {
  createDeployHandler,
};
