const { ensureLoginRewardPosts } = require("../modules/admin");
const { buildAttendanceNotifyPayload, ensureAttendanceRewardPosts } = require("../modules/attendance");
const { sendCounterPassLobbyNotifications } = require("../modules/event-pass");
const worldMap = require("../modules/world-map");

module.exports = {
  packetId: 204,
  name: "JOIN_LOBBY_REQ",
  handle(ctx, socket, packet) {
    const joinReq = ctx.decodeJoinLobbyReq(packet.payload);
    const user = ctx.findUserByAccessToken(joinReq.accessToken) || socket.session.user || ctx.createEphemeralUser();
    socket.session.user = user;
    if (ctx.config.USE_LOCAL_USER_DB && user.userUid) {
      const missionClock = ctx.getMissionClockOptions
        ? ctx.getMissionClockOptions()
        : { now: ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : undefined };
      let loginMissionChanged = false;
      try {
        loginMissionChanged = ctx.recordMissionLogin ? ctx.recordMissionLogin(user, missionClock) : false;
      } catch (error) {
        console.log(`[mission-login] skipped join-lobby update: ${error && error.message ? error.message : error}`);
      }
      const serverNow = ctx.getServerNowDate ? ctx.getServerNowDate() : new Date();
      user.lastJoinAt = serverNow.toISOString();
      const rewardPosts = ensureLoginRewardPosts(user);
      const attendancePosts = ensureAttendanceRewardPosts(user, { now: serverNow, clockNow: serverNow });
      if (rewardPosts > 0 || attendancePosts > 0) {
        console.log(
          `[user-db] queued inbox rewards uid=${user.userUid} loginPosts=${rewardPosts} attendancePosts=${attendancePosts}`
        );
      }
      if (loginMissionChanged) {
        console.log(`[user-db] login missions updated uid=${user.userUid} day=${String(missionClock.eventDateKey || "")}`);
      }
      ctx.saveUserDb();
    }

    const replay = socket.session.gameReplay;

    if (ctx.config.REPLAY_CAPTURED_GAME_FLOW && ctx.capturedGameFlow) {
      if (ctx.shouldUseLocalJoinLobbyAck(user)) {
        const joinLobbyPayload = ctx.buildJoinLobbyAckPayload(user);
        if (ctx.config.USE_LOCAL_USER_DB && user.userUid) ctx.saveUserDb();
        if (shouldUseOfficialTutorialLobbyOrder(user)) {
          sendOfficialTutorialJoinLobby(ctx, socket, replay, joinLobbyPayload);
          return true;
        }
        ctx.sendGameResponse(
          socket,
          packet,
          ctx.constants.JOIN_LOBBY_ACK,
          joinLobbyPayload,
          "join-lobby-local-progress"
        );
        replay.inGameFlow = true;
        if (!replay.bootLobbyTemplateSent) {
          sendJoinLobbyBootTemplates(ctx, socket, replay, user);
        }
        sendCounterPassLobbyBootstrap(ctx, socket);
        sendJoinLobbyRaidBootstrap(ctx, socket, user);
        if (typeof ctx.repairPostTutorialGuideMissionsForSocket === "function") {
          ctx.repairPostTutorialGuideMissionsForSocket(socket, {
            label: "join-lobby-post-tutorial-guide-mission-repair",
            notify: false,
          });
        }
        sendJoinLobbyPostBootStart(ctx, socket, replay);
        ctx.sendStaminaChargeNotifications(socket, "join-lobby-charge-item", { includeUnchanged: true, itemIds: [2, 13] });
        sendJoinLobbyPostBootRest(ctx, socket, replay);
        markPostLobbyBootTemplatesHandled(replay);
        replay.localJoinLobbyAckSent = true;
        ctx.skipCapturedGameThroughPacketId(socket, ctx.constants.JOIN_LOBBY_ACK);
      } else {
        replay.inGameFlow = true;
        if (ctx.hasTutorialProgress(user)) {
          console.log("[JOIN_LOBBY_REQ] using captured lobby ACK; local account overlay disabled");
        }
        ctx.sendCapturedGameThroughPacketId(socket, ctx.constants.JOIN_LOBBY_ACK, "join-lobby");
        sendCounterPassLobbyBootstrap(ctx, socket);
        sendJoinLobbyRaidBootstrap(ctx, socket, user);
        if (typeof ctx.repairPostTutorialGuideMissionsForSocket === "function") {
          ctx.repairPostTutorialGuideMissionsForSocket(socket, {
            label: "join-lobby-post-tutorial-guide-mission-repair",
            notify: false,
          });
        }
      }
      return true;
    }

    const joinLobbyPayload = ctx.buildJoinLobbyAckPayload(user);
    if (ctx.config.USE_LOCAL_USER_DB && user.userUid) ctx.saveUserDb();
    if (shouldUseOfficialTutorialLobbyOrder(user)) {
      sendOfficialTutorialJoinLobby(ctx, socket, replay, joinLobbyPayload);
      return true;
    }
    ctx.sendGameResponse(
      socket,
      packet,
      ctx.constants.JOIN_LOBBY_ACK,
      joinLobbyPayload,
      "join-lobby-local-progress"
    );
    replay.inGameFlow = true;
    if (!replay.bootLobbyTemplateSent) {
      sendJoinLobbyBootTemplates(ctx, socket, replay, user);
    }
    sendCounterPassLobbyBootstrap(ctx, socket);
    sendJoinLobbyRaidBootstrap(ctx, socket, user);
    if (typeof ctx.repairPostTutorialGuideMissionsForSocket === "function") {
      ctx.repairPostTutorialGuideMissionsForSocket(socket, {
        label: "join-lobby-post-tutorial-guide-mission-repair",
        notify: false,
      });
    }
    replay.nextServerSequence = Math.max(Number(replay.nextServerSequence || 1), Number(packet.sequence || 0) + 1);
    sendJoinLobbyPostBootStart(ctx, socket, replay);
    ctx.sendStaminaChargeNotifications(socket, "join-lobby-charge-item", { includeUnchanged: true, itemIds: [2, 13] });
    sendJoinLobbyPostBootRest(ctx, socket, replay);
    markPostLobbyBootTemplatesHandled(replay);
    replay.localJoinLobbyAckSent = true;
    return true;
  },
};

function shouldUseOfficialTutorialLobbyOrder(user) {
  const tutorial = user && user.tutorial && typeof user.tutorial === "object" ? user.tutorial : null;
  return Boolean(tutorial && tutorial.enabled !== false && tutorial.completed !== true && tutorial.loginMode !== "post-tutorial");
}

function sendOfficialTutorialJoinLobby(ctx, socket, replay, joinLobbyPayload) {
  replay.inGameFlow = true;
  if (!replay.bootLobbyTemplateSent) {
    ctx.sendCapturedGameTemplateRange(socket, 1, 7, "tutorial-join-lobby-boot", { forceReframe: false });
    replay.bootLobbyTemplateSent = true;
  }
  ctx.sendServerGamePacket(socket, ctx.constants.JOIN_LOBBY_ACK, joinLobbyPayload, "tutorial-join-lobby-local-progress");
  ctx.sendCapturedGameTemplateRange(socket, 9, 18, "tutorial-join-lobby-post-boot", { forceReframe: false });
  replay.bootPostListTemplateSent = true;
  replay.postLobbyBootTemplateSent = true;
  replay.localJoinLobbyAckSent = true;
  replay.inGameFlow = true;
  replay.nextServerIndex = Math.max(Number(replay.nextServerIndex || 1), 19);
}

function sendCounterPassLobbyBootstrap(ctx, socket) {
  sendCounterPassLobbyNotifications(ctx, socket, "join-lobby-counter-pass");
}

function sendJoinLobbyRaidBootstrap(ctx, socket, user) {
  if (!worldMap || typeof worldMap.sendRaidSnapshotData !== "function") return;
  const options = ctx.getMissionClockOptions
    ? ctx.getMissionClockOptions()
    : { now: ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : undefined };
  try {
    worldMap.sendRaidSnapshotData(ctx, socket, user, {
      ...options,
      includeWorldMap: true,
      worldMapLabel: "join-lobby-world-map-data",
      label: "join-lobby-my-raid-list",
      detailLabel: "join-lobby-raid-detail",
      coopLabel: "join-lobby-raid-coop-list",
      resultLabel: "join-lobby-raid-result-list",
      eventCancelLabel: "join-lobby-raid-event-clear",
      includeEmpty: true,
    });
  } catch (error) {
    console.log(`[join-lobby-raid] skipped bootstrap: ${error && error.message ? error.message : error}`);
  }
}

function sendJoinLobbyBootTemplates(ctx, socket, replay, user) {
  ctx.sendCapturedGameTemplateRange(socket, 1, 1, "join-lobby-boot");
  ctx.sendServerGamePacket(
    socket,
    1644,
    Buffer.concat([ctx.writeSignedVarInt(0), ctx.writeSignedVarInt(0)]),
    "join-lobby-boot-company-buff"
  );
  ctx.sendCapturedGameTemplateRange(socket, 3, 5, "join-lobby-boot");
  const serverNow = ctx.getServerNowDate ? ctx.getServerNowDate() : new Date();
  const attendancePayload = buildAttendanceNotifyPayload(user, { now: serverNow, clockNow: serverNow, consumePrompt: true });
  if (attendancePayload) {
    ctx.sendServerGamePacket(socket, 1640, attendancePayload, "attendance-not");
  }
  ctx.sendCapturedGameTemplateRange(socket, 7, 7, "join-lobby-boot");
  replay.bootLobbyTemplateSent = true;
}

function sendJoinLobbyPostBootStart(ctx, socket, replay) {
  if (!ctx.config.REPLAY_CAPTURED_GAME_FLOW || !ctx.capturedGameFlow || !replay || replay.postLobbyBootTemplateSent) {
    return;
  }
  ctx.sendCapturedGameTemplateRange(socket, 9, 9, "join-lobby-post-boot");
}

function sendJoinLobbyPostBootRest(ctx, socket, replay) {
  if (!ctx.config.REPLAY_CAPTURED_GAME_FLOW || !ctx.capturedGameFlow || !replay || replay.postLobbyBootTemplateSent) {
    return;
  }
  ctx.sendCapturedGameTemplateRange(socket, 12, 13, "join-lobby-post-boot");
  ctx.sendCapturedGameTemplateRange(socket, 15, 16, "join-lobby-post-boot");
  replay.postLobbyBootTemplateSent = true;
  replay.bootPostListTemplateSent = true;
  replay.nextServerIndex = Math.max(Number(replay.nextServerIndex || 1), 19);
}

function markPostLobbyBootTemplatesHandled(replay) {
  if (!replay || replay.bootPostListTemplateSent) return;
  replay.bootPostListTemplateSent = true;
}
