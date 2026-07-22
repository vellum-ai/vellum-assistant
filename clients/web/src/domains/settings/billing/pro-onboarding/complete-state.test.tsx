/**
 * Tests for the restyled `CompleteState` completion card. Renders via
 * `@testing-library/react` (happy-dom registered in test-setup.ts). The lazy
 * avatar-components hook and the SVG-compositing renderer are mocked so the
 * creature scatter resolves to stub spans; the assistant hook is stubbed to a
 * fixed name so the dynamic Return label is deterministic; and `useNavigate`
 * is captured so the return handler can be asserted without a Router.
 */
import * as reactRouter from "react-router";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { routes } from "@/utils/routes";

const OFFLINE_NOTICE =
  "Assistant will go offline briefly while it resizes. Chat might not work during that time.";

let avatarComponents: unknown = { colors: [] };
mock.module("@/utils/use-bundled-avatar-components", () => ({
  preloadBundledAvatarComponents: () => {},
  useBundledAvatarComponents: () => avatarComponents,
}));
mock.module("@/components/avatar-renderer", () => ({
  AvatarRenderer: () => <span data-testid="creature-avatar" />,
}));

let assistantName: string | null = "Velly";
mock.module("./use-preferred-or-active-assistant", () => ({
  usePreferredOrActiveAssistant: () =>
    assistantName == null ? undefined : { name: assistantName },
}));

const selectedAssistantIds: Array<string | null> = [];
mock.module("@/assistant/selection", () => ({
  setSelectedAssistant: async (id: string | null) => {
    selectedAssistantIds.push(id);
  },
}));

let navigateArgs: Array<[unknown, unknown]> = [];
mock.module("react-router", () => ({
  ...reactRouter,
  useNavigate: () => (to: unknown, opts: unknown) => {
    navigateArgs.push([to, opts]);
  },
}));

const { CompleteState } = await import("./complete-state");

beforeEach(() => {
  avatarComponents = { colors: [] };
  assistantName = "Velly";
  navigateArgs = [];
  selectedAssistantIds.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("CompleteState heading and creatures", () => {
  test("renders the all-set serif heading and subtitle", () => {
    const { getByText } = render(<CompleteState />);
    expect(getByText("You're all set!")).toBeTruthy();
    expect(getByText("Enjoy the new found power.")).toBeTruthy();
  });

  test("renders the full six-creature corner layer, aria-hidden", () => {
    const { getByTestId, getAllByTestId } = render(<CompleteState />);
    expect(getAllByTestId("creature-avatar")).toHaveLength(6);
    expect(getByTestId("creature-corners").getAttribute("aria-hidden")).toBe(
      "true",
    );
  });
});

describe("CompleteState return button", () => {
  test("keeps the dynamic assistant name and navigates home on click", () => {
    const { getByTestId } = render(<CompleteState />);

    const button = getByTestId("onboarding-complete-return");
    expect(button.textContent).toBe("Return to Velly");

    fireEvent.click(button);
    expect(navigateArgs).toEqual([[routes.assistant, { replace: true }]]);
  });

  test("selects the provisioned assistant before returning", () => {
    // Multi-assistant org: provisioning targeted assistant-b while another
    // assistant is active. The label names assistant-b, so the click must
    // land there rather than on whatever was active before.
    const { getByTestId } = render(<CompleteState assistantId="assistant-b" />);

    fireEvent.click(getByTestId("onboarding-complete-return"));

    expect(selectedAssistantIds).toEqual(["assistant-b"]);
    expect(navigateArgs).toEqual([[routes.assistant, { replace: true }]]);
  });

  test("leaves the selection alone when no provisioning target is named", () => {
    // Without a target the label already describes the active assistant, so
    // writing a selection would be a no-op at best and a switch at worst.
    const { getByTestId } = render(<CompleteState />);

    fireEvent.click(getByTestId("onboarding-complete-return"));

    expect(selectedAssistantIds).toEqual([]);
    expect(navigateArgs).toEqual([[routes.assistant, { replace: true }]]);
  });

  test("falls back to a generic label when no assistant resolves", () => {
    assistantName = null;
    const { getByTestId } = render(<CompleteState />);
    expect(getByTestId("onboarding-complete-return").textContent).toBe(
      "Return to your assistant",
    );
  });
});

describe("CompleteState offline notice", () => {
  test("is absent when not finishing in the background", () => {
    const { queryByText } = render(<CompleteState />);
    expect(queryByText(OFFLINE_NOTICE)).toBeNull();
  });

  test("shows only while finishing in background and clears once done", () => {
    const { queryByText, rerender } = render(
      <CompleteState finishedInBackground />,
    );
    expect(queryByText(OFFLINE_NOTICE)).toBeTruthy();
    // The still-mounted provisioning hook reaching DONE flips the prop off;
    // mirror that transition and confirm the notice clears.
    rerender(<CompleteState finishedInBackground={false} />);
    expect(queryByText(OFFLINE_NOTICE)).toBeNull();
  });

  test("stalled recovery controls take precedence over the offline notice", () => {
    const onApply = mock(() => {});
    const { getByTestId, getByText, queryByText } = render(
      <CompleteState
        finishedInBackground
        stalledAction={{ onApply, pending: false, error: null }}
      />,
    );

    expect(
      getByText(/We couldn't finish your machine upgrade automatically/),
    ).toBeTruthy();
    expect(queryByText(OFFLINE_NOTICE)).toBeNull();

    fireEvent.click(getByTestId("complete-stalled-apply"));
    expect(onApply).toHaveBeenCalledTimes(1);

    // The Return button stays available across all completion variants.
    expect(getByTestId("onboarding-complete-return")).toBeTruthy();
  });
});
