import { beforeEach, describe, expect, mock, test } from "bun:test";

const createGuardianRequestDeliveryMock = mock();
const updateGuardianRequestDeliveryMock = mock();

mock.module("../../channels/gateway-guardian-requests.js", () => ({
  createGuardianRequestDelivery: (...args: unknown[]) =>
    createGuardianRequestDeliveryMock(...args),
  updateGuardianRequestDelivery: (...args: unknown[]) =>
    updateGuardianRequestDeliveryMock(...args),
}));

import { recordGuardianRequestDeliveries } from "../guardian-delivery-recorder.js";
import type { NotificationDeliveryResult } from "../types.js";

beforeEach(() => {
  createGuardianRequestDeliveryMock.mockReset();
  updateGuardianRequestDeliveryMock.mockReset();
  createGuardianRequestDeliveryMock.mockImplementation(async () => ({
    id: `row-${createGuardianRequestDeliveryMock.mock.calls.length}`,
  }));
  updateGuardianRequestDeliveryMock.mockResolvedValue(undefined);
});

describe("recordGuardianRequestDeliveries", () => {
  test("records rows only for addressable channels, skipping platform", async () => {
    const deliveryResults: NotificationDeliveryResult[] = [
      {
        channel: "vellum",
        destination: "vellum",
        status: "sent",
        conversationId: "conv-1",
      },
      {
        // A forced platform push has no endpoint, so the broadcaster falls
        // back to the channel name as the destination -- it must never be
        // persisted as a destinationChatId.
        channel: "platform",
        destination: "platform",
        status: "pending",
      },
      {
        channel: "telegram",
        destination: "12345",
        status: "sent",
        conversationId: "conv-1",
        messageId: "tg-77",
      },
    ];

    await recordGuardianRequestDeliveries({
      requestId: "req-1",
      deliveryResults,
    });

    const channels = createGuardianRequestDeliveryMock.mock.calls.map(
      (call) => (call[0] as { destinationChannel: string }).destinationChannel,
    );
    expect(channels).toEqual(["vellum", "telegram"]);

    const telegramRow = createGuardianRequestDeliveryMock.mock.calls[1]![0] as {
      destinationChatId?: string;
      destinationMessageId?: string;
    };
    expect(telegramRow.destinationChatId).toBe("12345");
    expect(telegramRow.destinationMessageId).toBe("tg-77");

    // Status patches apply only to the rows that were created.
    expect(updateGuardianRequestDeliveryMock).toHaveBeenCalledTimes(2);
  });
});
