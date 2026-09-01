/**
 * A stored or deleted BYO email provider credential must drop the readiness
 * service's cached email snapshot: the BYO check lives in the TTL-cached
 * remote bucket, so without the invalidation the channel badge serves the
 * pre-write verdict for the rest of the TTL.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

let invalidatedChannels: string[];

mock.module("../daemon/handlers/config-channels.js", () => ({
  getReadinessService: () => ({
    invalidateChannel: (channel: string) => {
      invalidatedChannels.push(channel);
    },
  }),
}));

import { invalidateEmailReadinessForByoCredential } from "./byo-email-credential.js";

describe("invalidateEmailReadinessForByoCredential", () => {
  beforeEach(() => {
    invalidatedChannels = [];
  });

  test("invalidates the email channel for each BYO provider", async () => {
    await invalidateEmailReadinessForByoCredential("resend");
    await invalidateEmailReadinessForByoCredential("mailgun");

    expect(invalidatedChannels).toEqual(["email", "email"]);
  });

  test("leaves other services' credentials alone", async () => {
    await invalidateEmailReadinessForByoCredential("telegram");
    await invalidateEmailReadinessForByoCredential("slack_channel");

    expect(invalidatedChannels).toEqual([]);
  });
});
