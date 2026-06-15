// Combat tick/update logic.
//
// This file has no socket or packet-routing knowledge. It mutates battleState in
// place, and syncBuilder serializes the resulting state into GAME_SYNC (822).

const STAT_RATE_SCALE = 10000;
const TACTIC_UPDATE_STATS = Object.freeze({
  0: Object.freeze([
    Object.freeze({ statType: "NST_ATTACK_DAMAGE_MODIFY_G2", statValue: 400 }),
    Object.freeze({ statType: "NST_DAMAGE_REDUCE_RATE", statValue: 400 }),
    Object.freeze({ statType: "NST_COST_RETURN_RATE", statValue: 400 }),
    Object.freeze({ statType: "NST_ATTACK_DAMAGE_MODIFY_G2", statValue: 200 }),
    Object.freeze({ statType: "NST_DAMAGE_REDUCE_RATE", statValue: 200 }),
    Object.freeze({ statType: "NST_COST_RETURN_RATE", statValue: 200 }),
  ]),
  1: Object.freeze([
    Object.freeze({ statType: "NST_DAMAGE_REDUCE_RATE", statValue: 400 }),
    Object.freeze({ statType: "NST_DAMAGE_REDUCE_RATE", statValue: 400 }),
    Object.freeze({ statType: "NST_COST_RETURN_RATE", statValue: 400 }),
    Object.freeze({ statType: "NST_DAMAGE_REDUCE_RATE", statValue: 200 }),
    Object.freeze({ statType: "NST_DAMAGE_REDUCE_RATE", statValue: 200 }),
    Object.freeze({ statType: "NST_COST_RETURN_RATE", statValue: 200 }),
  ]),
});

function createTickEngine(options = {}) {
  const combatStateId = options.combatStateId || {
    IDLE: 12,
    MOVE: 13,
    ATTACK: 45,
    DEAD: 18,
  };
  const defaultCombatStats = options.defaultCombatStats || {
    damage: 10,
    attackRange: 130,
    moveSpeed: 55,
    attackCooldown: 1.2,
  };
  const staticCombatStats = options.staticCombatStats || {
    damage: 8,
    attackRange: 180,
    moveSpeed: 0,
    attackCooldown: 1.6,
  };
  const gameplayUnitStats = options.gameplayUnitStats || null;

  function continueBattleStateUnits(battleState, delta) {
    if (!battleState || !Array.isArray(battleState.units)) return;
    if (battleState.finished) return;
    const dt = clamp(Number(delta || 0.5), 0.05, 1);
    if (!Array.isArray(battleState.pendingDieUnitUIDs)) battleState.pendingDieUnitUIDs = [];
    if (!battleState.removedUnitUIDs) battleState.removedUnitUIDs = new Set();

    battleState.units = battleState.units.filter(Boolean);
    for (const unit of battleState.units) {
      normalizeBattleStateUnit(unit);
      ensureBattleRecordForUnit(battleState, unit);
    }

    const liveUnits = battleState.units.filter(isLiveBattleUnit);
    for (const unit of liveUnits) addBattleRecordPlayTime(battleState, unit, dt);
    const liveTeams = new Set(liveUnits.map((unit) => unit.team));
    if (liveTeams.size < 2) {
      for (const unit of liveUnits) {
        unit.targetUID = 0;
        unit.speedX = 0;
        setBattleUnitState(unit, combatStateId.IDLE);
      }
      cleanupDeadBattleUnits(battleState);
      settleBattleStateOutcome(battleState);
      return;
    }

    for (const unit of liveUnits.slice().sort((a, b) => Number(a.gameUnitUID || 0) - Number(b.gameUnitUID || 0))) {
      if (!isLiveBattleUnit(unit)) continue;
      const target = findNearestEnemyUnit(unit, battleState.units);
      if (!target) {
        unit.targetUID = 0;
        unit.speedX = 0;
        setBattleUnitState(unit, combatStateId.IDLE);
        continue;
      }

      const stats = getUnitCombatStats(unit);
      const targetX = Number(target.x || 0);
      const currentX = Number(unit.x || 0);
      const direction = targetX >= currentX ? 1 : -1;
      const distance = Math.abs(targetX - currentX);
      unit.targetUID = target.gameUnitUID || 0;
      unit.right = direction > 0;
      unit.attackTimer = Math.max(0, Number(unit.attackTimer || 0) - dt);

      if (distance > stats.attackRange && stats.moveSpeed > 0) {
        const step = Math.min(stats.moveSpeed * dt, Math.max(0, distance - stats.attackRange));
        unit.x = currentX + direction * step;
        unit.speedX = Math.abs(stats.moveSpeed);
        unit.savedPosX = unit.x;
        unit.hitDone = false;
        setBattleUnitState(unit, combatStateId.MOVE);
        continue;
      }

      unit.speedX = 0;
      unit.savedPosX = currentX;
      setBattleUnitState(unit, combatStateId.ATTACK);
      if (unit.attackTimer <= 0) {
        unit.attackTimer = stats.attackCooldown;
        const beforeHp = Math.max(0, Number(target.hp || 0));
        const damage = applyDamageReduction(target, stats.damage);
        const appliedDamage = Math.min(beforeHp, damage);
        target.hp = Math.max(0, beforeHp - damage);
        target.targetUID = unit.gameUnitUID || 0;
        recordBattleDamage(battleState, unit, target, appliedDamage);
        if (target.hp <= 0) markContinuationUnitDead(target, battleState, unit);
      }
    }

    cleanupDeadBattleUnits(battleState);
    settleBattleStateOutcome(battleState);
  }

  function settleBattleStateOutcome(battleState) {
    if (!battleState || battleState.finished) return;
    const liveUnits = (battleState.units || []).filter(isLiveBattleUnit);
    const livePlayers = liveUnits.filter((unit) => unit.team === 1);
    const liveEnemies = liveUnits.filter((unit) => unit.team !== 1);
    const elapsed = Number(battleState.gameTime || 0);
    if (liveEnemies.length === 0) {
      finishBattleState(battleState, true);
    } else if (elapsed > 0 && livePlayers.length === 0 && liveEnemies.length > 0) {
      finishBattleState(battleState, false);
    } else if (Number(battleState.remainGameTime || 0) <= 0) {
      finishBattleState(battleState, false);
    }
  }

  function finishBattleState(battleState, win) {
    battleState.finished = true;
    battleState.Finished = true;
    battleState.win = Boolean(win);
    battleState.Win = Boolean(win);
    battleState.gameState = { state: 4, winTeam: win ? 1 : 3, waveId: battleState.gameState ? battleState.gameState.waveId || 1 : 1 };
    battleState.GameState = { State: 4, WinTeam: win ? 1 : 3, WaveId: battleState.gameState ? battleState.gameState.waveId || 1 : 1 };
    if (!Array.isArray(battleState.pendingGameStates)) battleState.pendingGameStates = [];
    battleState.pendingGameStates.push(battleState.gameState);
  }

  function normalizeBattleStateUnit(unit) {
    unit.gameUnitUID = Number(unit.gameUnitUID || 0);
    unit.team = Number(unit.team || (unit.right === false ? 3 : 1));
    unit.x = finiteNumber(unit.x);
    unit.z = finiteNumber(unit.z);
    unit.hp = Math.max(0, finiteNumber(unit.hp));
    unit.maxHp = Math.max(1, finiteNumber(unit.maxHp) || unit.hp || 1);
    unit.savedPosX = finiteNumber(unit.savedPosX || unit.x);
    unit.speedX = finiteNumber(unit.speedX);
    unit.speedY = finiteNumber(unit.speedY);
    unit.speedZ = finiteNumber(unit.speedZ);
    unit.playState = unit.hp <= 0 ? 2 : unit.playState == null ? 1 : Number(unit.playState);
    if (unit.stateId == null || unit.stateId === 0) unit.stateId = combatStateId.IDLE;
    if (unit.stateChangeCount == null) unit.stateChangeCount = 1;
    hydrateBattleUnitStats(unit);
  }

  function isLiveBattleUnit(unit) {
    return Boolean(unit && unit.playState !== 0 && unit.playState !== 2 && Number(unit.hp || 0) > 0);
  }

  function findNearestEnemyUnit(unit, units) {
    let best = null;
    let bestDistance = Infinity;
    for (const other of units || []) {
      if (!isLiveBattleUnit(other) || other.gameUnitUID === unit.gameUnitUID || other.team === unit.team) continue;
      const distance = Math.abs(Number(other.x || 0) - Number(unit.x || 0));
      if (distance < bestDistance) {
        best = other;
        bestDistance = distance;
      }
    }
    return best;
  }

  function markContinuationUnitDead(unit, battleState, attacker) {
    if (!unit || unit.playState === 2 || unit.playState === 0) return;
    unit.hp = 0;
    unit.speedX = 0;
    unit.speedY = 0;
    unit.speedZ = 0;
    unit.targetUID = attacker && attacker.gameUnitUID ? attacker.gameUnitUID : unit.targetUID || 0;
    unit.respawn = false;
    unit.deadTicks = 0;
    unit.pendingRemove = true;
    unit.playState = 2;
    setBattleUnitState(unit, combatStateId.DEAD);
    applyCostReturn(unit, battleState);
    recordBattleDeath(battleState, unit, attacker);
    if (battleState) battleState.lastDeadUnitUID = unit.gameUnitUID;
  }

  function ensureBattleRecordForUnit(battleState, unit) {
    if (!battleState || !unit) return null;
    if (!battleState.unitRecords || typeof battleState.unitRecords !== "object") battleState.unitRecords = {};
    const gameUnitUID = Number(unit.gameUnitUID || unit.GameUnitUID || 0);
    if (!Number.isFinite(gameUnitUID) || gameUnitUID <= 0) return null;
    const key = String(gameUnitUID);
    const existing = battleState.unitRecords[key] || {};
    const record = {
      gameUnitUID,
      sourceUnitUID: existing.sourceUnitUID ?? unit.sourceUnitUID ?? unit.SourceUnitUID ?? "",
      role: existing.role ?? unit.role ?? unit.Role ?? "",
      unitId: positiveInt(existing.unitId ?? existing.unitID ?? unit.unitID ?? unit.unitId ?? unit.UnitID),
      changeUnitName: existing.changeUnitName ?? unit.changeUnitName ?? unit.ChangeUnitName ?? "",
      unitLevel: Math.max(1, positiveInt(existing.unitLevel ?? unit.unitLevel ?? unit.level ?? unit.Level ?? unit.UnitLevel) || 1),
      isSummonee: Boolean(existing.isSummonee ?? unit.isSummonee ?? unit.IsSummonee ?? false),
      isAssistUnit: Boolean(existing.isAssistUnit ?? unit.assistUnit ?? unit.isAssistUnit ?? unit.AssistUnit ?? false),
      isLeader: Boolean(existing.isLeader ?? unit.isLeader ?? unit.IsLeader ?? false),
      teamType: normalizeTeamType(existing.teamType ?? unit.teamType ?? unit.team ?? unit.Team),
      recordGiveDamage: finiteNumber(existing.recordGiveDamage),
      recordTakeDamage: finiteNumber(existing.recordTakeDamage),
      recordHeal: finiteNumber(existing.recordHeal),
      recordSummonCount: Math.max(positiveInt(existing.recordSummonCount), 1),
      recordDieCount: positiveInt(existing.recordDieCount),
      recordKillCount: positiveInt(existing.recordKillCount),
      playtime: finiteNumber(existing.playtime),
    };
    battleState.unitRecords[key] = record;
    return record;
  }

  function recordBattleDamage(battleState, attacker, target, damage) {
    const appliedDamage = finiteNumber(damage);
    if (!battleState || appliedDamage <= 0) return;
    const attackerRecord = ensureBattleRecordForUnit(battleState, attacker);
    const targetRecord = ensureBattleRecordForUnit(battleState, target);
    if (attackerRecord) attackerRecord.recordGiveDamage += appliedDamage;
    if (targetRecord) targetRecord.recordTakeDamage += appliedDamage;
  }

  function addBattleRecordPlayTime(battleState, unit, delta) {
    const record = ensureBattleRecordForUnit(battleState, unit);
    if (!record) return;
    record.playtime += Math.max(0, finiteNumber(delta));
  }

  function recordBattleDeath(battleState, unit, attacker) {
    if (!battleState || !unit || unit.deathRecorded) return;
    const record = ensureBattleRecordForUnit(battleState, unit);
    if (record) record.recordDieCount += 1;
    const attackerRecord = attacker ? ensureBattleRecordForUnit(battleState, attacker) : null;
    if (attackerRecord && Number(attacker.gameUnitUID || 0) !== Number(unit.gameUnitUID || 0)) {
      attackerRecord.recordKillCount += 1;
    }
    unit.deathRecorded = true;
  }

  function cleanupDeadBattleUnits(battleState) {
    const kept = [];
    for (const unit of battleState.units || []) {
      if (!unit) continue;
      if (unit.hp <= 0 || unit.playState === 2) {
        if (unit.playState !== 2) markContinuationUnitDead(unit, battleState, null);
        unit.deadTicks = Number(unit.deadTicks || 0) + 1;
        unit.speedX = 0;
        unit.respawn = false;
        unit.hp = 0;
        if (unit.deadTicks >= 2) {
          if (!battleState.removedUnitUIDs.has(unit.gameUnitUID)) {
            battleState.removedUnitUIDs.add(unit.gameUnitUID);
            battleState.pendingDieUnitUIDs.push(unit.gameUnitUID);
          }
          continue;
        }
      }
      kept.push(unit);
    }
    battleState.units = kept;
  }

  function hydrateBattleUnitStats(unit) {
    if (!unit || unit.combatStats) return unit && unit.combatStats;
    const tableStats = findGameplayUnitStats(unit);
    const baseStats = isStaticBattleUnit(unit) ? staticCombatStats : defaultCombatStats;
    unit.combatStats = {
      damage: finiteNumber(unit.attackDamage) || (tableStats ? tableStats.damage : baseStats.damage),
      attackRange: finiteNumber(unit.attackRange) || (tableStats ? tableStats.attackRange : baseStats.attackRange),
      moveSpeed: isStaticBattleUnit(unit) ? 0 : finiteNumber(unit.moveSpeed) || (tableStats ? tableStats.moveSpeed : baseStats.moveSpeed),
      attackCooldown: finiteNumber(unit.attackCooldown) || (tableStats ? tableStats.attackCooldown : baseStats.attackCooldown),
      damageReduceRate: finiteNumber(unit.damageReduceRate),
      costReturnRate: finiteNumber(unit.costReturnRate),
    };
    applyTacticUpdateStats(unit, unit.combatStats);
    if (tableStats && (!unit.maxHp || unit.maxHp <= 1)) unit.maxHp = Math.max(1, tableStats.hp || unit.maxHp || unit.hp || 1);
    return unit.combatStats;
  }

  function getUnitCombatStats(unit) {
    const stats = hydrateBattleUnitStats(unit) || defaultCombatStats;
    return {
      damage: clamp(finiteNumber(stats.damage) || defaultCombatStats.damage, 1, 1000000),
      attackRange: clamp(finiteNumber(stats.attackRange) || defaultCombatStats.attackRange, 1, 6000),
      moveSpeed: clamp(finiteNumber(stats.moveSpeed), 0, 1000),
      attackCooldown: clamp(finiteNumber(stats.attackCooldown) || defaultCombatStats.attackCooldown, 0.2, 30),
      damageReduceRate: clamp(finiteNumber(stats.damageReduceRate), 0, 9000),
      costReturnRate: clamp(finiteNumber(stats.costReturnRate), 0, STAT_RATE_SCALE),
    };
  }

  function applyTacticUpdateStats(unit, stats) {
    const tacticLevel = clamp(Math.trunc(readUnitNumber(unit, "tacticLevel", "TacticLevel")), 0, 6);
    if (!unit || !stats || tacticLevel <= 0) return;
    const tacticGroup = readUnitNumber(unit, "tacticGroup", "TacticGroup");
    const records = TACTIC_UPDATE_STATS[tacticGroup] || TACTIC_UPDATE_STATS[0] || [];
    let damageModifyRate = 0;
    let damageReduceRate = 0;
    let costReturnRate = 0;
    for (let index = 0; index < Math.min(tacticLevel, records.length); index += 1) {
      const record = records[index];
      switch (record.statType) {
        case "NST_ATTACK_DAMAGE_MODIFY_G2":
          damageModifyRate += finiteNumber(record.statValue);
          break;
        case "NST_DAMAGE_REDUCE_RATE":
          damageReduceRate += finiteNumber(record.statValue);
          break;
        case "NST_COST_RETURN_RATE":
          costReturnRate += finiteNumber(record.statValue);
          break;
        default:
          break;
      }
    }
    if (damageModifyRate > 0) stats.damage *= 1 + damageModifyRate / STAT_RATE_SCALE;
    stats.damageReduceRate = Math.max(finiteNumber(stats.damageReduceRate), damageReduceRate);
    stats.costReturnRate = Math.max(finiteNumber(stats.costReturnRate), costReturnRate);
    unit.damageReduceRate = stats.damageReduceRate;
    unit.costReturnRate = stats.costReturnRate;
  }

  function applyDamageReduction(target, damage) {
    const targetStats = hydrateBattleUnitStats(target) || defaultCombatStats;
    const rate = clamp(finiteNumber(targetStats.damageReduceRate ?? target.damageReduceRate), 0, 9000);
    return Math.max(1, finiteNumber(damage) * (1 - rate / STAT_RATE_SCALE));
  }

  function applyCostReturn(unit, battleState) {
    if (!unit || !battleState || unit.costReturnApplied) return;
    const stats = hydrateBattleUnitStats(unit) || defaultCombatStats;
    const rate = clamp(finiteNumber(stats.costReturnRate ?? unit.costReturnRate), 0, STAT_RATE_SCALE);
    const cost = finiteNumber(unit.cost ?? unit.deployCost ?? unit.respawnCost);
    unit.costReturnApplied = true;
    if (rate <= 0 || cost <= 0) return;
    const refund = cost * (rate / STAT_RATE_SCALE);
    if (unit.team === 1) {
      battleState.respawnCostA1 = clamp(finiteNumber(battleState.respawnCostA1) + refund, 0, 10);
    } else {
      battleState.respawnCostB1 = clamp(finiteNumber(battleState.respawnCostB1) + refund, 0, 10);
    }
  }

  function findGameplayUnitStats(unit) {
    if (!gameplayUnitStats || !gameplayUnitStats.loaded || !unit) return null;
    const ids = [unit.unitID, unit.unitId, unit.baseUnitID, unit.baseUnitId, unit.sourceUnitID, unit.sourceUnitId]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0 && value < 1000000);
    for (const id of ids) {
      const stats = gameplayUnitStats.byId.get(String(id));
      if (stats) return stats;
    }
    const strIds = [unit.unitStrID, unit.unitStrId, unit.sourceUnitStrID, unit.sourceUnitStrId].filter(Boolean);
    for (const strId of strIds) {
      const stats = gameplayUnitStats.byStrId.get(String(strId));
      if (stats) return stats;
    }
    return null;
  }

  function isStaticBattleUnit(unit) {
    const role = String((unit && unit.role) || "").toLowerCase();
    return role === "ship" || role === "core" || Number((unit && unit.gameUnitUID) || 0) <= 4;
  }

  function readUnitNumber(unit, ...keys) {
    if (!unit) return 0;
    for (const key of keys) {
      if (unit[key] == null || unit[key] === "") continue;
      const number = Number(unit[key]);
      if (Number.isFinite(number)) return number;
    }
    return 0;
  }

  function normalizeTeamType(value) {
    const team = positiveInt(value);
    return team === 2 ? 1 : team === 4 ? 3 : team > 0 ? team : 1;
  }

  function positiveInt(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
  }

  function setBattleUnitState(unit, stateId) {
    if (unit.stateId !== stateId) {
      unit.stateId = stateId;
      unit.stateChangeCount = clampSByte((unit.stateChangeCount || 0) + 1);
    }
  }

  return {
    continueBattleStateUnits,
    settleBattleStateOutcome,
    finishBattleState,
    normalizeBattleStateUnit,
    isLiveBattleUnit,
    findNearestEnemyUnit,
    markContinuationUnitDead,
    cleanupDeadBattleUnits,
    hydrateBattleUnitStats,
    ensureBattleRecordForUnit,
    recordBattleDamage,
    addBattleRecordPlayTime,
    recordBattleDeath,
    getUnitCombatStats,
    applyTacticUpdateStats,
    applyDamageReduction,
    applyCostReturn,
    findGameplayUnitStats,
    isStaticBattleUnit,
    setBattleUnitState,
    clamp,
    clampSByte,
    finiteNumber,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

function clampSByte(value) {
  const next = Number(value);
  if (next > 120) return -120;
  if (next < -120) return 0;
  return next;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

module.exports = {
  createTickEngine,
};
