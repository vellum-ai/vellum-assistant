import { describe, expect, test } from "bun:test";

import {
  DOCTOR_UNAVAILABLE_STREAM_MESSAGE,
  doctorStreamTerminalMessage,
} from "@/domains/settings/components/panels/doctor-errors";

describe("doctorStreamTerminalMessage", () => {
  test.each([502, 503, 504])(
    "maps gateway status %i to the Doctor-unavailable message",
    (status) => {
      expect(doctorStreamTerminalMessage(status)).toBe(
        DOCTOR_UNAVAILABLE_STREAM_MESSAGE,
      );
    },
  );

  test("keeps the status-specific message for non-gateway failures", () => {
    expect(doctorStreamTerminalMessage(401)).toBe(
      "Failed to connect to event stream (401). Start a new session to continue.",
    );
  });

  test("keeps the generic message when the stream dropped without a status", () => {
    expect(doctorStreamTerminalMessage(null)).toBe(
      "Event stream disconnected. Start a new session to continue.",
    );
  });
});
