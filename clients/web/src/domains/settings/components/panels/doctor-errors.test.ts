import { describe, expect, test } from "bun:test";

import {
  DOCTOR_UNAVAILABLE_STREAM_MESSAGE,
  doctorStreamTerminalMessage,
  isExpectedDoctorApiError,
} from "@/domains/settings/components/panels/doctor-errors";
import { ApiError } from "@/utils/api-errors";

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

  test("points at reconnect when the stream dropped without a status", () => {
    expect(doctorStreamTerminalMessage(null)).toBe(
      "Event stream disconnected. Reconnect to continue this session.",
    );
  });
});

describe("isExpectedDoctorApiError", () => {
  test.each([429, 502, 503, 504])(
    "treats ApiError %i as expected (skips Sentry)",
    (status) => {
      expect(isExpectedDoctorApiError(new ApiError(status, "msg"))).toBe(true);
    },
  );

  test("still reports unexpected ApiError statuses", () => {
    expect(isExpectedDoctorApiError(new ApiError(500, "msg"))).toBe(false);
  });

  test("still reports non-ApiError failures", () => {
    expect(isExpectedDoctorApiError(new Error("boom"))).toBe(false);
  });
});
