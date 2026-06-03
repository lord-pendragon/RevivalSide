module.exports = {
  packetId: 812,
  name: "GAME_PAUSE_REQ",
  handle(ctx, socket, packet) {
    const replay = socket.session.gameReplay;
    if (ctx.isTutorialCapturedBootstrapActive(socket)) {
      if (ctx.peekCapturedTutorialPacketId(socket) === ctx.constants.HEART_BIT_ACK) {
        console.log("[official-missing] GAME_PAUSE_REQ arrived before tutorial heartbeat sync window; no response sent");
        return true;
      }
      if (!ctx.sendCapturedTutorialThroughPacketId(socket, ctx.constants.GAME_PAUSE_ACK, "tutorial-game-pause")) {
        console.log(
          `[official-missing] no sniffed tutorial GAME_PAUSE_ACK for pauseCount=${replay.pauseCount + 1} nextServerIndex=${
            replay.nextServerIndex
          }; no response sent`
        );
      }
      replay.pauseCount += 1;
      return true;
    }
    if (ctx.config.DYNAMIC_BATTLE_MANAGER) {
      const payload = ctx.decryptCopy(packet.payload);
      const isPause = payload.length > 0 ? payload.readUInt8(0) !== 0 : true;
      const isPauseEvent = payload.length > 1 ? payload.readUInt8(1) !== 0 : false;
      ctx.handleDynamicBattlePause(socket, { isPause, isPauseEvent });
      return true;
    }
    if (!ctx.config.REPLAY_CAPTURED_GAME_FLOW || !ctx.capturedGameFlow) return false;

    if (ctx.peekCapturedGamePacketId(socket) === ctx.constants.HEART_BIT_ACK) {
      console.log(
        "[official-missing] GAME_PAUSE_REQ arrived before captured heartbeat sync window; no response sent"
      );
      return true;
    }

    if (!ctx.sendCapturedGameThroughPacketId(socket, ctx.constants.GAME_PAUSE_ACK, "game-pause")) {
      console.log(
        `[official-missing] no sniffed GAME_PAUSE_ACK for pauseCount=${replay.pauseCount + 1} nextServerIndex=${
          replay.nextServerIndex
        }; no response sent`
      );
    }

    replay.pauseCount += 1;
    return true;
  },
};
