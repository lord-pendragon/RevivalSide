const { getTutorialStageForRequest, isTutorialDungeonId, isTutorialStageId, TUTORIAL_STAGE_CHAIN } = require("../stages/tutorialStage");
const { getMainStoryStageForRequest } = require("../stages/mainStoryStage");
const { buildPlayerDeckForGameLoad } = require("../modules/unit");
const { eventDeckHasFreeShipSlot, eventDeckHasGivenUnitSlots, getEventDeckPlayerUnitSlots } = require("../modules/game-data");
const worldMap = require("../modules/world-map");

const NGT_DIVE = 5;

module.exports = {
  packetId: 801,
  name: "GAME_LOAD_REQ",
  handle(ctx, socket, packet) {
    ctx.logGameLoadReq(packet.payload);
    const req = ctx.decodeGameLoadReq(packet.payload);
    // Stage selection can arrive with a stale/captured dungeonID. Prefer the
    // selected stageID first so Act 2+ does not get pulled back into 1004.
    // Tutorial stages must come from tutorialStage.js, not the main-story catalog
    // wrapper, because that module carries the phase-specific tutorial runtime.
    const user = socket.session && socket.session.user;
    const requestedStageId = Number((req && req.stageID) || 0);
    const requestedDungeonId = Number((req && req.dungeonID) || 0);
    const explicitTutorial = isTutorialStageId(requestedStageId) || isTutorialDungeonId(requestedDungeonId);
    const diveGameLoad = req && Number(req.diveStageID || 0) > 0 ? worldMap.prepareDiveGameLoad(user, req) : null;
    let stage = null;
    if (diveGameLoad) {
      const diveStage =
        (ctx.getGenericStageForRequest ? ctx.getGenericStageForRequest({ dungeonID: diveGameLoad.dungeonID }) : null) ||
        (ctx.getGenericStageForRequest
          ? ctx.getGenericStageForRequest({ stageID: requestedStageId, dungeonID: diveGameLoad.dungeonID })
          : null) ||
        {};
      req.stageID = Number(diveStage.stageId || requestedStageId || diveGameLoad.diveStageID || 0);
      req.dungeonID = diveGameLoad.dungeonID;
      req.gameType = NGT_DIVE;
      stage = {
        ...diveStage,
        stageId: req.stageID,
        dungeonID: diveGameLoad.dungeonID,
        gameType: NGT_DIVE,
        eventDeckId: 0,
        EventDeckId: 0,
        miscMode: "dive",
        diveStageID: diveGameLoad.diveStageID,
        diveDeckIndex: diveGameLoad.deckIndex,
        tutorial: false,
        cutsceneOnly: false,
      };
      console.log(
        `[game-load:dive] diveStageID=${diveGameLoad.diveStageID} dungeonID=${diveGameLoad.dungeonID} deck=${diveGameLoad.deckIndex}`
      );
    } else {
      stage = (explicitTutorial
        ? getTutorialStageForRequest({ stageID: requestedStageId, dungeonID: requestedDungeonId })
        : getMainStoryStageForRequest({ stageID: requestedStageId, dungeonID: 0 })) ||
        getMainStoryStageForRequest(req) ||
        getTutorialStageForRequest(req) ||
        (ctx.getGenericStageForRequest ? ctx.getGenericStageForRequest(req) : null);
    }
    if (stage) {
      req.stageID = stage.stageId;
      req.dungeonID = stage.dungeonID;
    }
    if (stage && stage.tutorial && user) {
      const expectedTutorialStage = getExpectedTutorialStageForUser(user);
      if (
        expectedTutorialStage &&
        (Number(stage.stageId) !== Number(expectedTutorialStage.stageId) ||
          Number(stage.dungeonID) !== Number(expectedTutorialStage.dungeonID))
      ) {
        const redirectedStage = getTutorialStageForRequest({
          stageID: expectedTutorialStage.stageId,
          dungeonID: expectedTutorialStage.dungeonID,
        });
        if (redirectedStage) {
          console.log(
            `[game-load:tutorial] redirect stageID=${stage.stageId} dungeonID=${stage.dungeonID} -> stageID=${redirectedStage.stageId} dungeonID=${redirectedStage.dungeonID}`
          );
          stage = redirectedStage;
          req.stageID = stage.stageId;
          req.dungeonID = stage.dungeonID;
        }
      }
    }
    if (socket.session && socket.session.gameReplay) {
      socket.session.gameReplay.lastGameLoadReq = {
        stageID: Number((req && req.stageID) || 0),
        dungeonID: Number((req && req.dungeonID) || 0),
      };
    }
    const eventDeckId = stage ? Number(stage.eventDeckId || stage.EventDeckId || 0) : 0;
    const usesEventDeck = eventDeckId > 0;
    const eventDeckPlayerUnitSlots = usesEventDeck ? getEventDeckPlayerUnitSlots(eventDeckId) : [];
    const eventDeckAllowsPlayerUnits = eventDeckPlayerUnitSlots.length > 0;
    const usesHybridEventDeck = eventDeckAllowsPlayerUnits && eventDeckHasGivenUnitSlots(eventDeckId);
    let playerDeck = null;
    if (stage && !stage.cutsceneOnly) {
      if (stage.tutorial || (usesEventDeck && !eventDeckAllowsPlayerUnits)) {
        playerDeck = buildPlayerIdentityForGameLoad(user);
      } else if (eventDeckAllowsPlayerUnits) {
        const eventDeckSelection = req && req.eventDeckData ? req.eventDeckData : null;
        playerDeck =
          buildPlayerDeckForGameLoad(user, req, {
            allowedUnitSlots: eventDeckPlayerUnitSlots,
            slotUnitUids: eventDeckSelection && eventDeckSelection.units,
            shipUid: eventDeckSelection && eventDeckSelection.shipUid,
            operatorUid: eventDeckSelection && eventDeckSelection.operatorUid,
            leaderIndex: eventDeckSelection && eventDeckSelection.leaderIndex,
          }) || buildPlayerIdentityForGameLoad(user);
      } else {
        playerDeck = buildPlayerDeckForGameLoad(user, req) || buildPlayerIdentityForGameLoad(user);
      }
    }
    if (playerDeck && !stage.tutorial && playerDeck.units && playerDeck.units.length) {
      console.log(
        `[game-load] selectedDeck deckType=${playerDeck.deckType} index=${playerDeck.deckIndex} ${
          usesEventDeck
            ? `eventDeck=${eventDeckId} playerSlots=${eventDeckPlayerUnitSlots.join("/") || "none"} source=${
                req && req.eventDeckData ? "eventDeckData" : "deck"
              } `
            : ""
        }units=${playerDeck.units
          .map((unit) => `${unit.slotIndex}:${unit.unitId}/${unit.unitUid}`)
          .join(",")} leader=${playerDeck.leaderIndex}:${playerDeck.leaderUnitUid} ship=${playerDeck.shipUnitId}/${
          playerDeck.shipUid
        } operator=${playerDeck.operatorId}/${playerDeck.operatorUid}`
      );
    } else if (stage && usesEventDeck) {
      console.log(`[game-load] eventDeck=${stage.eventDeckId || stage.EventDeckId} stageID=${stage.stageId} dungeonID=${stage.dungeonID}`);
    }
    const activeStage =
      stage && !stage.cutsceneOnly
        ? {
            ...stage,
            eventDeckFreeUnitSlots: eventDeckPlayerUnitSlots,
            usesHybridEventDeck,
            eventDeckFreeShipSlot: usesEventDeck ? eventDeckHasFreeShipSlot(eventDeckId) : false,
            playerDeck,
          }
        : stage;
    if (ctx.config.REPLAY_CAPTURED_GAME_FLOW && ctx.capturedGameFlow) {
      ctx.logCapturedClientPacketMatch(packet, 10, "game-load");
    }
    if (!activeStage || activeStage.tutorial) ctx.maybeSendTutorialCutsceneClear(socket, packet.payload);
    if (ctx.config.DYNAMIC_BATTLE_MANAGER && activeStage && !activeStage.cutsceneOnly && ctx.sendDynamicGameLoadAck(socket, req, activeStage)) {
      return true;
    }
    if (ctx.config.REPLAY_CAPTURED_GAME_FLOW && ctx.capturedGameFlow) {
      ctx.sendCapturedGameThroughPacketId(socket, ctx.constants.GAME_LOAD_ACK, "game-load");
      ctx.scheduleCapturedGameAutoAdvance(socket);
      return true;
    }
    return false;
  },
};

function buildPlayerIdentityForGameLoad(user) {
  if (!user) return null;
  return {
    userUid: String(user.userUid || "0"),
    nickname: String(user.nickname || "LocalAdmin"),
    userLevel: Number(user.level || 1),
    units: [],
  };
}

function getExpectedTutorialStageForUser(user) {
  const tutorial = user && user.tutorial && typeof user.tutorial === "object" ? user.tutorial : null;
  if (!tutorial || tutorial.enabled === false || tutorial.completed === true || tutorial.loginMode === "post-tutorial") return null;
  const phases = tutorial.phases && typeof tutorial.phases === "object" ? tutorial.phases : {};
  for (const stage of TUTORIAL_STAGE_CHAIN) {
    const phase = phases[String(stage.dungeonID)] || phases[String(stage.stageId)];
    if (!phase || phase.completed !== true) return stage;
  }
  return null;
}
