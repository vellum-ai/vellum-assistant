import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let fetchPolicies: ReturnType<
  typeof mock<(assistantId: string) => Promise<unknown>>
>;
let setPolicy: ReturnType<typeof mock<(...args: unknown[]) => Promise<unknown>>>;

mock.module("@/lib/channel-admission-policy/api", () => ({
  fetchChannelPolicies: (assistantId: string) => fetchPolicies(assistantId),
  setChannelPolicy: (...args: unknown[]) => setPolicy(...args),
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  },
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "asst-1",
}));

const { ChannelPolicyCard } = await import("./channel-policy-card");

beforeEach(() => {
  fetchPolicies = mock(async () => []);
  setPolicy = mock(async () => ({
    channelType: "slack",
    policy: "guardian_only",
    note: null,
    updatedAt: 1,
  }));
});

afterEach(() => {
  cleanup();
  fetchPolicies.mockClear();
  setPolicy.mockClear();
});

describe("ChannelPolicyCard", () => {
  test("renders the heading and helper copy", async () => {
    render(<ChannelPolicyCard />);
    await waitFor(() =>
      expect(screen.getByText("Channel Trust Floors")).toBeTruthy(),
    );
    expect(
      screen.getByText(/Internal channels are managed automatically/i),
    ).toBeTruthy();
  });

  test("renders a row per client-controllable channel returned by the API", async () => {
    fetchPolicies = mock(async () => [
      {
        channelType: "slack",
        policy: "trusted_contacts",
        note: null,
        updatedAt: null,
      },
      {
        channelType: "email",
        policy: "guardian_only",
        note: null,
        updatedAt: null,
      },
    ]);

    render(<ChannelPolicyCard />);

    await waitFor(() => {
      expect(screen.getByTestId("channel-policy-row-slack")).toBeTruthy();
      expect(screen.getByTestId("channel-policy-row-email")).toBeTruthy();
    });
  });

  test("surfaces an error message when loading fails", async () => {
    fetchPolicies = mock(async () => {
      throw new Error("network down");
    });

    render(<ChannelPolicyCard />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
  });
});
