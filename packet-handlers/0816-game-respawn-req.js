module.exports = {
  packetId: 816,
  name: "GAME_RESPAWN_REQ",
  handle(ctx, socket, packet) {
    const req = ctx.decodeGameRespawnReq(packet.payload);
    if (req) {
      socket.session.gameReplay.lastRespawnReq = req;
      console.log(
        `[GAME_RESPAWN_REQ] unitUID=${req.unitUID} assist=${req.assistUnit ? 1 : 0} posX=${req.respawnPosX.toFixed(
          2
        )} gameTime=${req.gameTime.toFixed(2)}`
      );
    }
    if (ctx.isTutorialCapturedBootstrapActive(socket)) {
      if (!ctx.sendCapturedTutorialThroughPacketId(socket, ctx.constants.GAME_RESPAWN_ACK, "tutorial-game-respawn")) {
        console.log(
          `[official-missing] no sniffed tutorial GAME_RESPAWN_ACK for nextServerIndex=${socket.session.gameReplay.nextServerIndex}; no response sent`
        );
        return true;
      }
      ctx.sendCapturedTutorialUntilBeforePacketIds(
        socket,
        [ctx.constants.HEART_BIT_ACK, ctx.constants.GAME_PAUSE_ACK, ctx.constants.GAME_RESPAWN_ACK],
        "tutorial-game-respawn-sync"
      );
      ctx.maybeTransitionTutorialReplayToDynamic(socket, "game-respawn");
      return true;
    }
    if (ctx.config.DYNAMIC_BATTLE_MANAGER && ctx.handleDynamicBattleRespawn(socket, req)) {
      return true;
    }
    if (ctx.config.DYNAMIC_BATTLE_MANAGER) {
      console.log("[combat-host] GAME_RESPAWN_REQ not handled by combat host; captured respawn replay disabled");
      return true;
    }
    if (!ctx.config.REPLAY_CAPTURED_GAME_FLOW || !ctx.capturedGameFlow) return false;
    if (!ctx.sendCapturedGameThroughPacketId(socket, ctx.constants.GAME_RESPAWN_ACK, "game-respawn")) {
      console.log(
        `[official-missing] no sniffed GAME_RESPAWN_ACK for nextServerIndex=${socket.session.gameReplay.nextServerIndex}; no response sent`
      );
      return true;
    }
    ctx.sendCapturedGameUntilBeforePacketIds(
      socket,
      [ctx.constants.HEART_BIT_ACK, ctx.constants.GAME_PAUSE_ACK, ctx.constants.GAME_RESPAWN_ACK],
      "game-respawn-sync"
    );
    return true;
  },
};
