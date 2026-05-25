const { presetListAck } = require("..");

module.exports = {
  packetId: 1038,
  name: "EQUIP_PRESET_LIST_REQ",
  handle(ctx, socket, packet) {
    const user = socket.session && socket.session.user;
    ctx.sendGameResponse(
      socket,
      packet,
      ctx.constants.EQUIP_PRESET_LIST_ACK,
      presetListAck(user),
      "equip-preset-list"
    );
    if (socket.session && socket.session.gameReplay && ctx.capturedGameFlow) {
      ctx.skipCapturedGameThroughPacketId(socket, ctx.constants.EQUIP_PRESET_LIST_ACK);
    }
    return true;
  },
};
