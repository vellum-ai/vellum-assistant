/**
 * What the progress pill says about the plan behind it.
 *
 * The trigger names its own state, so the label, the glyph and the loading
 * sweep all have to agree with the plan: "Progress" with a step ring and a
 * shimmering label while work is outstanding, "Finished" with a check and a
 * label at rest once it is not.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";

// Pin the platform to a pointer device so the control opens a popover rather
// than the touch bottom sheet, and stub the sweep to a marker: it animates via
// the Web Animations API, which the test DOM does not implement.
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => false,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));
mock.module("@/hooks/use-touch-mobile", () => ({
  useTouchMobile: () => false,
  TOUCH_MOBILE_MEDIA_QUERY: "(width < 48rem) and (pointer: coarse)",
}));
// The label's sweep animates through the Web Animations API, which the test
// DOM does not implement; the component still renders its span, so the testid
// is enough to assert which state the label is in.

const sdkStub = async () => ({ data: undefined });
const realSdkPath = new URL(
  "../../../generated/daemon/sdk.gen.ts",
  import.meta.url,
).pathname;
const sdkSource = await Bun.file(realSdkPath).text();
const exportNames = [...sdkSource.matchAll(/^export const (\w+)/gm)].map(
  (m) => m[1]!,
);
mock.module("@/generated/daemon/sdk.gen", () =>
  Object.fromEntries(exportNames.map((n) => [n, sdkStub])),
);

const { ProgressCard } = await import(
  "@/domains/chat/components/progress-card"
);
const { useChatSessionStore } = await import(
  "@/domains/chat/chat-session-store"
);
const { useProgressAckStore } = await import(
  "@/domains/chat/progress-ack-store"
);

const T0 = 1_700_000_000_000;

function seedPlan(
  status: string | undefined,
  steps: { label: string; status?: string }[],
): void {
  useChatSessionStore.setState({
    snapshot: {
      messages: [
        {
          id: "m-plan",
          role: "assistant",
          timestamp: T0,
          surfaces: [
            {
              surfaceId: "sfc-plan",
              type: "card",
              data: {
                template: "task_progress",
                templateData: { title: "Build it", status, steps },
              },
            },
          ],
        },
      ],
    },
    optimisticSends: [],
    dismissedSurfaceIds: new Set<string>(),
  } as never);
}

/**
 * The entrance wrapper resolves the assistant's avatar through TanStack Query,
 * so the tree needs a client even though these tests never assert on it.
 */
function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ProgressCard />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  // The acknowledgement set is a module singleton, and every plan here shares
  // one surface id: without this, the first test to acknowledge would hide the
  // control for all the rest.
  useProgressAckStore.setState({ acknowledged: new Set<string>() });
  useChatSessionStore.setState({
    snapshot: { messages: [] },
    optimisticSends: [],
    dismissedSurfaceIds: new Set<string>(),
  } as never);
});

describe("ProgressCard trigger", () => {
  test("a running plan reads Progress, shimmers, and rings its position", () => {
    seedPlan("in_progress", [{ label: "Step 1", status: "in_progress" }]);
    renderCard();

    expect(screen.getByTestId("progress-card-toggle").textContent).toContain(
      "Progress",
    );
    expect(screen.queryByTestId("progress-label-shimmer")).not.toBeNull();
    // The ring stands in for the glyph while running: one arc over its track.
    expect(
      screen.getByTestId("progress-card-toggle").querySelectorAll("circle"),
    ).toHaveLength(2);
  });

  test("a finished plan reads Finished and does not sweep", () => {
    seedPlan("completed", [{ label: "Step 1", status: "completed" }]);
    renderCard();

    expect(screen.getByTestId("progress-card-toggle").textContent).toContain(
      "Finished",
    );
    expect(screen.queryByTestId("progress-label-shimmer")).toBeNull();
  });

  test("a terminal card settles even with a step left in flight", () => {
    // The model can mark a plan done and leave a step reading `in_progress`
    // behind it. Taking the steps at face value there would leave the pill
    // sweeping under a finished plan forever.
    seedPlan("completed", [
      { label: "Step 1", status: "completed" },
      { label: "Step 2", status: "in_progress" },
    ]);
    renderCard();

    expect(screen.getByTestId("progress-card-toggle").textContent).toContain(
      "Finished",
    );
    expect(screen.queryByTestId("progress-label-shimmer")).toBeNull();
  });

  test("a step in flight counts as running when the card says nothing", () => {
    // The inverse: `status` is not always set mid-run, and the steps are what
    // actually report the work.
    seedPlan(undefined, [{ label: "Step 1", status: "in_progress" }]);
    renderCard();

    expect(screen.getByTestId("progress-card-toggle").textContent).toContain(
      "Progress",
    );
    expect(screen.queryByTestId("progress-label-shimmer")).not.toBeNull();
  });
});
