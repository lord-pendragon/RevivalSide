const { sendCounterPassLobbyNotifications } = require("../modules/event-pass");

module.exports = {
  packetId: 604,
  name: "SERVER_TIME_REQ",
  handle(ctx, socket, packet) {
    const serverTicks = ctx.dateTimeTicksNow
      ? ctx.dateTimeTicksNow()
      : BigInt(Date.now()) * 10000n + 621355968000000000n;
    if (ctx.config.REPLAY_CAPTURED_GAME_FLOW && ctx.capturedGameFlow) {
      ctx.skipStaleTutorialGameLoadReplay(socket, "server-time");
      if (typeof ctx.sendCapturedGameUntilBeforePacketIds === "function") {
        ctx.sendCapturedGameUntilBeforePacketIds(socket, [ctx.constants.SERVER_TIME_ACK], "server-time-prelude");
      }
      ctx.skipCapturedGameThroughPacketId(socket, ctx.constants.SERVER_TIME_ACK);
    }
    ctx.sendGameResponse(
      socket,
      packet,
      ctx.constants.SERVER_TIME_ACK,
      ctx.writeSignedVarLong(serverTicks),
      "server-time"
    );
    sendCounterPassLobbyNotifications(ctx, socket, "server-time-counter-pass", { resendIfNoAck: true });
    return true;
  },
};
