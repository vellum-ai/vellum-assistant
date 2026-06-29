import type { ChannelTransport } from "../channel-transport.js";
import { deliverA2AReply } from "./deliver.js";

export const a2aTransport: ChannelTransport = {
  channel: "a2a",

  async deliver(ctx, payload) {
    return deliverA2AReply(ctx.callbackUrl, payload);
  },
};
