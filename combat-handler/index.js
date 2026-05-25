const syncBuilder = require("./syncBuilder");
const { createTickEngine } = require("./tick");
const { createBattleStateManager, buildCapturedRespawnUnitPools } = require("./battleState");
const { createDeployHandler } = require("./deploy");
const { createCsharpCombatHost } = require("./csharpHost");

// Combat handler facade.
//
// cs-listener.js owns sockets, encryption, packet ordering, and captured-flow
// routing. This facade owns combat state and tells the listener which combat
// payloads to send.

function createCombatHandler(options = {}) {
  const constants = options.constants || {};
  const config = options.config || {};
  const csharpHost = createCsharpCombatHost({
    enabled: Boolean(config.CSHARP_COMBAT_HOST),
    projectPath: config.CSHARP_COMBAT_HOST_PROJECT,
    dllPath: config.CSHARP_COMBAT_HOST_DLL,
    timeoutMs: config.CSHARP_COMBAT_HOST_TIMEOUT_MS,
    managedDir: config.COUNTERSIDE_MANAGED_DIR,
    gameplayTablesDir: config.GAMEPLAY_TABLES_DIR,
    dotnetPath: config.CSHARP_COMBAT_HOST_DOTNET,
    syncIntervalSeconds: Number(config.MANAGED_HOST_TICK_INTERVAL_MS || 33) / 1000,
    defaultUnitDamage: options.defaultCombatStats && options.defaultCombatStats.damage,
    defaultUnitAttackRange: options.defaultCombatStats && options.defaultCombatStats.attackRange,
    defaultUnitMoveSpeed: options.defaultCombatStats && options.defaultCombatStats.moveSpeed,
    defaultUnitAttackCooldown: options.defaultCombatStats && options.defaultCombatStats.attackCooldown,
    staticUnitDamage: options.staticCombatStats && options.staticCombatStats.damage,
    staticUnitAttackRange: options.staticCombatStats && options.staticCombatStats.attackRange,
    staticUnitAttackCooldown: options.staticCombatStats && options.staticCombatStats.attackCooldown,
    defaultDeployedUnitHp: options.defaultDeployedUnitHp,
  });
  let csharpWarningPrinted = false;
  if (csharpHost.enabled) {
    const warmup = csharpHost.request("warmup", {});
    if (!warmup.ok) warnCsharpFallback(warmup.error);
  }
  const tickEngine = createTickEngine({
    combatStateId: options.combatStateId,
    defaultCombatStats: options.defaultCombatStats,
    staticCombatStats: options.staticCombatStats,
    gameplayUnitStats: options.gameplayUnitStats,
  });
  const stateManager = createBattleStateManager({
    tick: tickEngine,
    capturedGameFlow: options.capturedGameFlow,
    capturedRespawnUnitPools: options.capturedRespawnUnitPools,
    parseCapturedGameSyncPayload: options.parseCapturedGameSyncPayload,
    extractGameLoadUnitPools: options.extractGameLoadUnitPools,
  });
  const deployHandler = createDeployHandler({
    tick: tickEngine,
    combatStateId: options.combatStateId,
    defaultDeployedUnitHp: options.defaultDeployedUnitHp,
  });

  function startBattle(initialData) {
    if (csharpHost.enabled && initialData && initialData.replay && initialData.req) {
      const gameUID =
        initialData.gameUID ||
        (typeof options.makeDynamicGameUid === "function" ? options.makeDynamicGameUid() : BigInt(Date.now()) * 10000n);
      const response = csharpHost.request("startBattle", {
        req: initialData.req,
        stage: initialData.stage || {},
        gameUID: String(gameUID),
        gameLoadAckPayloadBase64: initialData.gameLoadAckPayloadBase64 || "",
      });
      if (response.ok && response.dynamicGame && response.battleState && response.dynamicGame.managedCombat && response.payload) {
        initialData.replay.dynamicGame = response.dynamicGame;
        initialData.replay.battleState = response.battleState;
        initialData.replay.dynamicGame.gameUID = gameUID;
        initialData.replay.dynamicGame.playerDeck = (initialData.stage && initialData.stage.playerDeck) || null;
        initialData.replay.battleState.gameUID = gameUID;
        initialData.replay.tutorialReplayPhase = "dynamic";
        initialData.replay.syntheticGameTime = Number(response.battleState.gameTime || 4);
        initialData.replay.dynamicBattleResultSent = false;
        initialData.replay.managedGameLoadAckPayload = response.payload || null;
        return response.dynamicGame;
      }
      warnCsharpFallback(response.error || "managed local server did not return GAME_LOAD_ACK");
      return null;
    }
    warnCsharpFallback("C# combat host disabled");
    return null;
  }

  function attachGameLoadUnitPools(replay, activeStage, payload) {
    return stateManager.attachGameLoadUnitPools(replay, activeStage, payload);
  }

  function handleDeploy(request) {
    const replay = request && request.replay;
    if (csharpHost.enabled && replay && replay.battleState && replay.dynamicGame && request.req) {
      const response = csharpHost.request("handleDeploy", {
        dynamicGame: replay.dynamicGame,
        battleState: replay.battleState,
        req: request.req,
      });
      if (response.ok && response.deployed && response.deployed.handled) {
        applyHostState(replay, response);
        mirrorManagedDeployToBattleState(replay, request.req);
        const ack = (response.packets || []).find((packet) => packet.packetId === 817);
        const sync = (response.packets || []).find((packet) => packet.packetId === 822);
        const packets = (response.packets || [])
          .filter((packet) => packet && packet.packetId && packet.payload)
          .map((packet) => ({ packetId: packet.packetId, payload: packet.payload, label: packet.label || "managed-deploy" }));
        return {
          handled: true,
          mode: response.deployed.mode || "battleState",
          deployed: response.deployed.unit || null,
          spawned: response.deployed.spawned || null,
          packets,
          ackPayload: ack && ack.payload,
          syncPayload: sync && sync.payload,
        };
      }
      if (replay.dynamicGame && replay.dynamicGame.managedCombat) {
        console.log(`[combat-host] managed deploy failed: ${summarizeHostError(response.error)}`);
        return { handled: false, error: response.error || "managed deploy failed" };
      }
      warnCsharpFallback(response.error);
    }
    return { handled: false };
  }

  function handlePause(request = {}) {
    const replay = request.replay;
    const req = request.req;
    if (!replay || !req) return { handled: false };
    if (csharpHost.enabled && replay.battleState && replay.dynamicGame && replay.dynamicGame.managedCombat) {
      const response = csharpHost.request("handlePause", {
        dynamicGame: replay.dynamicGame,
        battleState: replay.battleState,
        req,
      });
      if (response.ok) {
        applyHostState(replay, response);
        const packets = (response.packets || [])
          .filter((packet) => packet && packet.packetId && packet.payload)
          .map((packet) => ({ packetId: packet.packetId, payload: packet.payload, label: packet.label || "managed-pause" }));
        return {
          handled: true,
          packets,
          ackPayload: packets.find((packet) => packet.packetId === 813)?.payload || null,
        };
      }
      console.log(`[combat-host] managed pause failed: ${summarizeHostError(response.error)}`);
      return { handled: false };
    }
    return { handled: false };
  }

  function handleUnitSkill(request = {}) {
    return handleManagedSkill("handleUnitSkill", request, "managed-unit-skill");
  }

  function handleShipSkill(request = {}) {
    return handleManagedSkill("handleShipSkill", request, "managed-ship-skill");
  }

  function handleManagedSkill(command, request, fallbackLabel) {
    const replay = request.replay;
    const req = request.req;
    if (!replay || !req) return { handled: false };
    if (csharpHost.enabled && replay.battleState && replay.dynamicGame && replay.dynamicGame.managedCombat) {
      const response = csharpHost.request(command, {
        dynamicGame: replay.dynamicGame,
        battleState: replay.battleState,
        req,
      });
      if (response.ok) {
        applyHostState(replay, response);
        const packets = (response.packets || [])
          .filter((packet) => packet && packet.packetId && packet.payload)
          .map((packet) => ({ packetId: packet.packetId, payload: packet.payload, label: packet.label || fallbackLabel }));
        return {
          handled: true,
          mode: "managed-local-server",
          packets,
        };
      }
      console.log(`[combat-host] ${command} failed: ${summarizeHostError(response.error)}`);
      return { handled: false, error: response.error || `${command} failed` };
    }
    return { handled: false };
  }

  function tick(delta, battleState) {
    return tickEngine.continueBattleStateUnits(battleState, delta);
  }

  function buildSync(data = {}) {
    const defaultDelta = defaultSyncDelta(data.dynamicGame);
    if (csharpHost.enabled && data.battleState) {
      const response = csharpHost.request("buildSync", {
        dynamicGame: data.dynamicGame,
        battleState: data.battleState,
        delta: data.delta == null ? defaultDelta : Number(data.delta),
        skipSimulation: Boolean(data.skipSimulation),
      });
      if (response.ok) {
        if (response.battleState) replaceMutable(data.battleState, response.battleState);
        return response.payload || null;
      }
      if (data.dynamicGame && data.dynamicGame.managedCombat) {
        console.log(`[combat-host] managed sync failed: ${summarizeHostError(response.error)}`);
        return null;
      }
      warnCsharpFallback(response.error);
    }
    return null;
  }

  function buildSyncPackets(data = {}) {
    const defaultDelta = defaultSyncDelta(data.dynamicGame);
    if (csharpHost.enabled && data.battleState) {
      const response = csharpHost.request("buildSync", {
        dynamicGame: data.dynamicGame,
        battleState: data.battleState,
        delta: data.delta == null ? defaultDelta : Number(data.delta),
        skipSimulation: Boolean(data.skipSimulation),
      });
      if (response.ok) {
        if (response.battleState) replaceMutable(data.battleState, response.battleState);
        if (Array.isArray(response.packets) && response.packets.length > 0) {
          return response.packets
            .filter((packet) => packet && packet.packetId && packet.payload)
            .map((packet) => ({ packetId: packet.packetId, payload: packet.payload, label: packet.label || "managed-sync" }));
        }
        if (response.payload) {
          return [{ packetId: constants.NPT_GAME_SYNC_DATA_PACK_NOT, payload: response.payload, label: "managed-sync" }];
        }
        return [];
      }
      if (data.dynamicGame && data.dynamicGame.managedCombat) {
        console.log(`[combat-host] managed sync packets failed: ${summarizeHostError(response.error)}`);
        return [];
      }
      warnCsharpFallback(response.error);
    }
    return [];
  }

  function buildInitialSync(replay) {
    if (csharpHost.enabled && replay && replay.battleState) {
      const response = csharpHost.request("buildInitialSync", {
        dynamicGame: replay.dynamicGame,
        battleState: replay.battleState,
      });
      if (response.ok && response.payload) {
        applyHostState(replay, response);
        return response.payload;
      }
      warnCsharpFallback(response.error);
    }
    return null;
  }

  function buildInitialPackets(replay) {
    if (csharpHost.enabled && replay && replay.battleState) {
      const response = csharpHost.request("buildInitialSync", {
        dynamicGame: replay.dynamicGame,
        battleState: replay.battleState,
      });
      if (response.ok) {
        applyHostState(replay, response);
        if (Array.isArray(response.packets) && response.packets.length > 0) {
          return response.packets
            .filter((packet) => packet && packet.packetId && packet.payload)
            .map((packet) => ({ packetId: packet.packetId, payload: packet.payload, label: packet.label || "managed-initial" }));
        }
        if (response.payload) {
          return [{ packetId: constants.NPT_GAME_SYNC_DATA_PACK_NOT, payload: response.payload, label: "managed-initial-sync" }];
        }
      }
      if (replay.dynamicGame && replay.dynamicGame.managedCombat) {
        console.log(`[combat-host] managed initial packets failed: ${summarizeHostError(response.error)}`);
        return [];
      }
      warnCsharpFallback(response.error);
    }
    return [];
  }

  function buildRespawnAck(data = {}) {
    if (csharpHost.enabled) {
      const response = csharpHost.request("buildRespawnAck", {
        unitUID: data.unitUID,
        assistUnit: Boolean(data.assistUnit),
      });
      if (response.ok && response.payload) return response.payload;
      warnCsharpFallback(response.error);
    }
    return syncBuilder.buildRespawnAck(data);
  }

  function buildGameRespawnAckPayload(unitUID, assistUnit) {
    return buildRespawnAck({ unitUID, assistUnit });
  }

  function mergeJoinLobbyAck(officialPayload, localPayload, options = {}) {
    if (!csharpHost.enabled) {
      return { ok: false, error: "C# combat host disabled" };
    }
    const response = csharpHost.request("mergeJoinLobbyAck", {
      officialPayloadBase64: Buffer.from(officialPayload || Buffer.alloc(0)).toString("base64"),
      localPayloadBase64: Buffer.from(localPayload || Buffer.alloc(0)).toString("base64"),
      copyIntervalData: Boolean(options.copyIntervalData),
      replaceIntervalData: Boolean(options.replaceIntervalData),
      excludeIntervalStrKeys: Array.isArray(options.excludeIntervalStrKeys)
        ? options.excludeIntervalStrKeys.map((key) => String(key || "")).filter(Boolean)
        : [],
      preserveIntervalStrKeys: Array.isArray(options.preserveIntervalStrKeys)
        ? options.preserveIntervalStrKeys.map((key) => String(key || "")).filter(Boolean)
        : [],
      filterInactiveEventIntervals: Boolean(options.filterInactiveEventIntervals),
    });
    if (!response.ok || !response.payload) {
      return { ok: false, error: response.error || "managed lobby merge failed" };
    }
    return {
      ok: true,
      payload: response.payload,
      packetType: response.packetType,
      serializedPayloadSize: response.serializedPayloadSize,
    };
  }

  function normalizeJoinLobbyAck(localPayload) {
    if (!csharpHost.enabled) {
      return { ok: false, error: "C# combat host disabled" };
    }
    const response = csharpHost.request("normalizeJoinLobbyAck", {
      localPayloadBase64: Buffer.from(localPayload || Buffer.alloc(0)).toString("base64"),
    });
    if (!response.ok || !response.payload) {
      return { ok: false, error: response.error || "managed lobby normalize failed" };
    }
    return {
      ok: true,
      payload: response.payload,
      packetType: response.packetType,
      serializedPayloadSize: response.serializedPayloadSize,
    };
  }

  function buildSyntheticGameSyncPayload(gameTime) {
    if (csharpHost.enabled) {
      const response = csharpHost.request("buildSyntheticSync", { gameTime: Number(gameTime || 0) });
      if (response.ok && response.payload) return response.payload;
      warnCsharpFallback(response.error);
    }
    return syncBuilder.buildSyntheticGameSyncPayload(gameTime);
  }

  function startBattleLoop(socket, label, callbacks = {}) {
    const replay = socket.session && socket.session.gameReplay;
    if (!replay || replay.dynamicBattleTimer || !config.DYNAMIC_BATTLE_MANAGER) return false;
    const syncInterval =
      replay.dynamicGame && replay.dynamicGame.managedCombat
        ? Number(config.MANAGED_HOST_TICK_INTERVAL_MS || 33)
        : Number(config.DYNAMIC_BATTLE_SYNC_INTERVAL_MS || 33);
    const managedCombat = Boolean(replay.dynamicGame && replay.dynamicGame.managedCombat);
    const primeFrames = managedCombat ? Math.max(1, Number(config.MANAGED_HOST_PRIME_FRAMES || 1)) : 1;
    console.log(`[battle-manager:${label}] started interval=${syncInterval}ms`);
    let lastPumpAt = Date.now();
    let firstPump = true;

    function sendPumpedPackets(packets, pumpOptions = {}) {
      const endIndex = packets.findIndex((packet) => packet && packet.packetId === constants.GAME_END_NOT);
      const outboundPackets = (endIndex >= 0 ? packets.slice(0, endIndex + 1) : packets).filter(
        (packet) => packet && packet.packetId && packet.payload
      );
      const outboundEndIndex = outboundPackets.findIndex((packet) => packet && packet.packetId === constants.GAME_END_NOT);
      const quietManagedBurst =
        managedCombat && pumpOptions.dropQuietManagedSync && isQuietManagedSyncBurst(outboundPackets, constants);
      if (quietManagedBurst) {
        return { running: true, sent: false, quiet: true };
      }
      const canCork = typeof socket.cork === "function" && typeof socket.uncork === "function";
      if (canCork) socket.cork();
      try {
        for (const packet of outboundPackets) {
          callbacks.sendGamePacket(socket, packet.packetId, packet.payload, packet.label || "battle-manager-sync");
        }
      } finally {
        if (canCork) socket.uncork();
      }
      if (outboundEndIndex >= 0) {
        replay.dynamicBattleResultSent = true;
        if (replay.dynamicBattleTimer) clearInterval(replay.dynamicBattleTimer);
        replay.dynamicBattleTimer = null;
        if (typeof callbacks.onGameEndPacketSent === "function") {
          callbacks.onGameEndPacketSent(socket);
        }
        console.log("[battle-manager] managed combat emitted GAME_END_NOT; stopped sync loop");
        return { running: false, sent: outboundPackets.length > 0 };
      }
      const finishedState = replay.battleState && replay.battleState.finished ? replay.battleState : null;
      if (finishedState && finishedState.finished && !replay.dynamicBattleResultSent) {
        replay.dynamicBattleResultSent = true;
        if (replay.dynamicBattleTimer) clearInterval(replay.dynamicBattleTimer);
        replay.dynamicBattleTimer = null;
        const resultSent =
          typeof callbacks.sendBattleResult === "function"
            ? callbacks.sendBattleResult(socket, finishedState) === true
            : false;
        console.log(
          `[battle-manager] result=${finishedState.win ? "win" : "loss"} gameTime=${Number(
            finishedState.gameTime || 0
          ).toFixed(2)}`
        );
        return { running: false, sent: outboundPackets.length > 0 || resultSent };
      }
      return { running: true, sent: outboundPackets.length > 0 };
    }

    const pump = (pumpOptions = {}) => {
      if (socket.destroyed) {
        if (typeof callbacks.stopTimers === "function") callbacks.stopTimers(socket);
        return { running: false, sent: false };
      }
      const now = Date.now();
      const elapsedSeconds = firstPump ? syncInterval / 1000 : (now - lastPumpAt) / 1000;
      firstPump = false;
      lastPumpAt = now;
      // Managed combat uses wall-clock delta so C# reflection/serialization
      // stalls do not make the server simulation trail the client. The host
      // splits this into normal managed frames and drains packets per frame.
      const delta = managedCombat
        ? clampValue(elapsedSeconds, 0.001, defaultSyncDelta(replay.dynamicGame) * 3)
        : clampValue(elapsedSeconds, 0.001, 0.25);
      if (!replay.battleState || !replay.dynamicGame || !replay.dynamicGame.managedCombat) {
        console.log("[battle-manager] managed combat state unavailable; JS simulator fallback is disabled");
        return { running: false, sent: false };
      }
      const packets = buildSyncPackets({ dynamicGame: replay.dynamicGame, battleState: replay.battleState, delta });
      return sendPumpedPackets(packets, pumpOptions);
    };
    for (let index = 0; index < primeFrames; index += 1) {
      const result = pump({ dropQuietManagedSync: managedCombat && index < primeFrames - 1, sync: true });
      if (!result.running) return true;
      if (result.sent) break;
    }
    replay.dynamicBattleTimer = setInterval(() => {
      pump();
    }, syncInterval);
    if (typeof replay.dynamicBattleTimer.unref === "function") replay.dynamicBattleTimer.unref();
    return true;
  }

  function defaultSyncDelta(dynamicGame) {
    const intervalMs =
      dynamicGame && dynamicGame.managedCombat
        ? Number(config.MANAGED_HOST_TICK_INTERVAL_MS || 33)
        : Number(config.DYNAMIC_BATTLE_SYNC_INTERVAL_MS || 33);
    return clampValue(intervalMs / 1000, 0.001, 0.25);
  }

  function clampValue(value, min, max) {
    return Math.min(max, Math.max(min, Number(value)));
  }

  function isQuietManagedSyncBurst(packets, packetConstants) {
    const outbound = (packets || []).filter((packet) => packet && packet.packetId && packet.payload);
    if (outbound.length === 0) return true;
    return outbound.every(
      (packet) =>
        packet.packetId === packetConstants.NPT_GAME_SYNC_DATA_PACK_NOT &&
        Buffer.isBuffer(packet.payload) &&
        packet.payload.length <= 64
    );
  }

  function transitionTutorialReplayToDynamic(replay, endIndex) {
    return stateManager.transitionTutorialReplayToDynamic(replay, endIndex);
  }

  function isFinished(replayOrState) {
    const state = replayOrState && replayOrState.battleState ? replayOrState.battleState : replayOrState;
    return Boolean(state && state.finished);
  }

  function getResult(replayOrState) {
    const state = replayOrState && replayOrState.battleState ? replayOrState.battleState : replayOrState;
    if (!state || !state.finished) return null;
    return { win: Boolean(state.win), gameTime: Number(state.gameTime || 0), state };
  }

  function deployStageLineup(replay) {
    if (csharpHost.enabled && replay && replay.battleState && replay.dynamicGame) {
      const response = csharpHost.request("deployStageLineup", {
        dynamicGame: replay.dynamicGame,
        battleState: replay.battleState,
      });
      if (response.ok && response.deployed) {
        applyHostState(replay, response);
        return response.deployed.spawned || [];
      }
      warnCsharpFallback(response.error);
    }
    return [];
  }

  function applyHostState(replay, response) {
    if (!replay || !response) return;
    if (response.dynamicGame) {
      if (replay.dynamicGame) replaceMutable(replay.dynamicGame, response.dynamicGame);
      else replay.dynamicGame = response.dynamicGame;
    }
    if (response.battleState) {
      if (replay.battleState) replaceMutable(replay.battleState, response.battleState);
      else replay.battleState = response.battleState;
      deployHandler.enrichBattleStateUnitsFromPlayerDeck(replay);
    }
  }

  function replaceMutable(target, source) {
    if (!target || !source) return source;
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, source);
    return target;
  }

  function mirrorManagedDeployToBattleState(replay, req) {
    const battleState = replay && replay.battleState;
    if (!battleState || !req || !Array.isArray(battleState.units)) return;
    const unitUID = String(req.unitUID || "");
    if (unitUID && battleState.units.some((unit) => String(unit.sourceUnitUID || "") === unitUID && !unit.pendingRemove)) return;
    deployHandler.deployRuntimeBattleUnit(replay, req);
  }

  function warnCsharpFallback(error) {
    if (csharpWarningPrinted) return;
    csharpWarningPrinted = true;
    console.log(
      `[combat-host] managed CounterSide local server unavailable; JS combat simulator fallback disabled${
        error ? `: ${summarizeHostError(error)}` : ""
      }`
    );
  }

  function summarizeHostError(error) {
    const lines = String(error || "")
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return (
      lines.find((line) => line.startsWith("---> System.")) ||
      lines.find((line) => line.startsWith("System.") && !line.includes("TargetInvocationException")) ||
      lines[0] ||
      "unknown error"
    ).replace(/^---> /, "");
  }

  return {
    startBattle,
    handleDeploy,
    handlePause,
    handleUnitSkill,
    handleShipSkill,
    tick,
    buildSync,
    buildGameSync: buildSync,
    buildGameSyncPackets: buildSyncPackets,
    buildInitialBattleSync: buildInitialSync,
    buildInitialBattlePackets: buildInitialPackets,
    buildRespawnAck,
    buildGameRespawnAckPayload,
    mergeJoinLobbyAck,
    normalizeJoinLobbyAck,
    buildGameEndNot: syncBuilder.buildGameEndNot,
    buildSyntheticGameSyncPayload,
    startBattleLoop,
    isFinished,
    getResult,
    deployStageLineup,
    attachGameLoadUnitPools,
    describeRuntimeGameUnitPools: stateManager.describeRuntimeGameUnitPools,
    transitionTutorialReplayToDynamic,
  };
}

module.exports = {
  createCombatHandler,
  buildCapturedRespawnUnitPools,
};
