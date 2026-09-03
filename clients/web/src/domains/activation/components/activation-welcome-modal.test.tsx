/**
 * The modal's own behaviour: which row is open, what a launch does to the
 * accordion, and what each variant offers as a way out.
 *
 * Mocked at the transport, not at the seams. `mock.module` replaces a module
 * for every test file sharing the process, so stubbing the launch hook here
 * would erase the real one for its own test file, and stubbing
 * `conversation-navigation` would do the same to the settings surfaces that
 * mock it. Stubbing `fetch` and reading the router costs a little more setup
 * and reaches further: the assertions below see the prompt that actually goes
 * on the wire.
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";

import {
  ACTIVATION_PROGRESS_ALL_DONE,
  ACTIVATION_PROGRESS_EMPTY,
  ACTIVATION_PROGRESS_ONE_WORKING,
  FIXTURE_STARTER_IDS,
} from "@/domains/activation/activation-test-fixtures";
import {
  installActivationFetchStub,
  seedActivationIdentity,
  type ActivationFetchStub,
} from "@/domains/activation/activation-test-helpers";
import { useActivationUiStore } from "@/domains/activation/activation-ui-store";
import { getActivationList } from "@/domains/activation/catalog";
import { ActivationWelcomeModal } from "@/domains/activation/components/activation-welcome-modal";
import type { ActivationProgress } from "@/domains/activation/hooks/use-activation-progress";

const { starters, items } = getActivationList("smb");
const ASSISTANT_ID = "asst-1";

let fetchStub: ActivationFetchStub;
let startStatus = 200;
/**
 * Resolvers for the `start` writes still out, so a test can hold one launch
 * open, begin another, and settle them in whatever order it wants to prove.
 */
let heldStarts: (() => void)[] | null = null;

/** The prompt bodies that reached `POST /v1/messages`. */
function sentPrompts(): unknown[] {
  return fetchStub
    .matching("/messages")
    .map((request) => request.body.message ?? request.body.content);
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The start leg parks so a test can hold one launch open while it begins
 * another, which the shared stub's status and body tables cannot express.
 */
async function answerRequest(request: {
  url: string;
}): Promise<Response | undefined> {
  if (request.url.includes("/messages")) {
    return json({
      accepted: true,
      messageId: "m1",
      conversationId: "conv-1",
    });
  }
  if (request.url.includes("/activation/tasks/")) {
    if (heldStarts) {
      await new Promise<void>((resolve) => heldStarts?.push(resolve));
    }
    if (startStatus !== 200) {
      return new Response(JSON.stringify({ detail: "task id rejected" }), {
        status: startStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    return json({ taskId: "t", status: "started" });
  }
  if (request.url.includes("/conversations")) {
    return json({
      id: "conv-1",
      conversationKey: "",
      conversationType: "standard",
      created: true,
    });
  }
  return undefined;
}

/** Reads the address back so navigation can be asserted without a mock. */
function LocationProbe(): ReactNode {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function renderModal(
  progress: ActivationProgress,
  variant: "welcome" | "all-done" = "welcome",
  onDismiss: () => void = () => {},
): ReturnType<typeof render> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/assistant/conversation/c0"]}>
        <LocationProbe />
        <ActivationWelcomeModal
          open
          listId="smb"
          progress={progress}
          variant={variant}
          onDismiss={onDismiss}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  startStatus = 200;
  heldStarts = null;
  fetchStub = installActivationFetchStub({ respond: answerRequest });
  seedActivationIdentity(ASSISTANT_ID);
  useActivationUiStore.getState().resetTransientState();
});

afterEach(() => {
  cleanup();
  fetchStub.restore();
});

describe("ActivationWelcomeModal", () => {
  test("opens the first unstarted starter and only that one", () => {
    const { queryAllByLabelText } = renderModal(ACTIVATION_PROGRESS_EMPTY);
    expect(useActivationUiStore.getState().expandedTaskId).toBe(
      FIXTURE_STARTER_IDS[0],
    );
    expect(queryAllByLabelText("Custom:")).toHaveLength(1);
  });

  test("opening another row closes the one that was open", () => {
    const { getByText, queryAllByLabelText } = renderModal(
      ACTIVATION_PROGRESS_EMPTY,
    );
    fireEvent.click(getByText(starters[1]!.title));
    expect(useActivationUiStore.getState().expandedTaskId).toBe(
      FIXTURE_STARTER_IDS[1],
    );
    expect(queryAllByLabelText("Custom:")).toHaveLength(1);
  });

  test("skips a started task when it seeds the open row", () => {
    renderModal(ACTIVATION_PROGRESS_ONE_WORKING);
    expect(useActivationUiStore.getState().expandedTaskId).toBe(
      FIXTURE_STARTER_IDS[1],
    );
  });

  test("the chip sends the task's catalog prompt", async () => {
    const { getByText } = renderModal(ACTIVATION_PROGRESS_EMPTY);
    await act(async () => {
      fireEvent.click(getByText(starters[0]!.chip));
    });
    expect(sentPrompts()).toEqual([starters[0]!.prompt]);
  });

  test("the chip links the task before it sends anything", async () => {
    const { getByText } = renderModal(ACTIVATION_PROGRESS_EMPTY);
    await act(async () => {
      fireEvent.click(getByText(starters[0]!.chip));
    });
    const start = fetchStub.matching(
      `/activation/tasks/${FIXTURE_STARTER_IDS[0]}/start`,
    )[0];
    expect(start?.body).toEqual({ conversationId: "conv-1", listId: "smb" });
  });

  test("the Custom field sends the typed prompt instead", async () => {
    const { getByLabelText, getByRole } = renderModal(
      ACTIVATION_PROGRESS_EMPTY,
    );
    fireEvent.change(getByLabelText("Custom:"), {
      target: { value: "quote for Acme" },
    });
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Send" }));
    });
    expect(sentPrompts()).toEqual(["quote for Acme"]);
  });

  /**
   * A prompt sent against a task the daemon has no link for would run work the
   * checklist can never observe, so a refused link has to stop the send.
   */
  test("a refused link sends no prompt", async () => {
    startStatus = 400;
    const { getByText } = renderModal(ACTIVATION_PROGRESS_EMPTY);
    await act(async () => {
      fireEvent.click(getByText(starters[0]!.chip));
    });
    expect(sentPrompts()).toEqual([]);
  });

  test("a launch moves the accordion on to the next unstarted row", async () => {
    const { getByText } = renderModal(ACTIVATION_PROGRESS_EMPTY);
    await act(async () => {
      fireEvent.click(getByText(starters[0]!.chip));
    });
    expect(useActivationUiStore.getState().expandedTaskId).toBe(
      FIXTURE_STARTER_IDS[1],
    );
  });

  // A row the daemon refused is the row the user still has to deal with, so
  // the accordion has nowhere to move on to.
  test("a refused launch leaves the accordion where it was", async () => {
    startStatus = 400;
    const { getByText } = renderModal(ACTIVATION_PROGRESS_EMPTY);
    await act(async () => {
      fireEvent.click(getByText(starters[0]!.chip));
    });
    expect(useActivationUiStore.getState().expandedTaskId).toBe(
      FIXTURE_STARTER_IDS[0],
    );
  });

  // The user opened another row while the launch was out. That choice is
  // theirs, and a launch landing afterwards must not take it back.
  test("a launch does not overwrite a row opened while it was out", async () => {
    heldStarts = [];
    const { getByText } = renderModal(ACTIVATION_PROGRESS_EMPTY);
    fireEvent.click(getByText(starters[0]!.chip));
    fireEvent.click(getByText(starters[2]!.title));
    expect(useActivationUiStore.getState().expandedTaskId).toBe(
      FIXTURE_STARTER_IDS[2],
    );

    await act(async () => {
      heldStarts?.forEach((resolve) => resolve());
      heldStarts = null;
    });
    expect(useActivationUiStore.getState().expandedTaskId).toBe(
      FIXTURE_STARTER_IDS[2],
    );
  });

  // Two launches can be out at once. Each row locks only itself, and it stays
  // locked until its own launch settles, whichever one settles first.
  test("a second launch does not unlock the first row", async () => {
    heldStarts = [];
    const { getByRole, getByText } = renderModal(ACTIVATION_PROGRESS_EMPTY);
    fireEvent.click(getByText(starters[0]!.chip));
    fireEvent.click(getByText(starters[1]!.title));
    fireEvent.click(getByText(starters[1]!.chip));

    // Settle the second launch alone, then look at the first row again.
    await act(async () => {
      heldStarts?.splice(1).forEach((resolve) => resolve());
    });
    fireEvent.click(getByText(starters[0]!.title));
    expect(
      (getByRole("button", { name: starters[0]!.chip }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await act(async () => {
      heldStarts?.forEach((resolve) => resolve());
      heldStarts = null;
    });
  });

  test("Show More counts the rest of the catalog and opens it inline", () => {
    const { getByRole, getByText } = renderModal(ACTIVATION_PROGRESS_EMPTY);
    fireEvent.click(
      getByRole("button", { name: `Show More (${items.length})` }),
    );
    expect(useActivationUiStore.getState().showMore).toBe(true);
    expect(getByText(items[0]!.title)).not.toBeNull();
  });

  test("Do it Later dismisses", () => {
    let dismissals = 0;
    const { getByRole } = renderModal(
      ACTIVATION_PROGRESS_EMPTY,
      "welcome",
      () => {
        dismissals += 1;
      },
    );
    fireEvent.click(getByRole("button", { name: "Do it Later" }));
    expect(dismissals).toBe(1);
  });

  test("clicking a finished row opens its conversation", () => {
    const { getByRole, getByTestId } = renderModal(
      ACTIVATION_PROGRESS_ALL_DONE,
      "all-done",
    );
    fireEvent.click(
      getByRole("button", { name: `Open ${starters[0]!.title}` }),
    );
    expect(getByTestId("location").textContent).toContain("conv-done-1");
  });

  test("the celebration offers the full list instead of a way to put it off", () => {
    const { getByRole, queryByRole } = renderModal(
      ACTIVATION_PROGRESS_ALL_DONE,
      "all-done",
    );
    expect(queryByRole("button", { name: "Do it Later" })).toBeNull();
    expect(
      getByRole("button", { name: "Show me the full list" }),
    ).not.toBeNull();
  });

  // "Welcome!" over a checklist the user has just finished reads as a surface
  // that was not watching, so the band carries the variant's own copy.
  test("the welcome band greets a first visit", () => {
    const { getByText } = renderModal(ACTIVATION_PROGRESS_EMPTY);
    expect(getByText("Welcome!")).not.toBeNull();
  });

  test("the celebration band congratulates instead of greeting", () => {
    const { getByText, queryByText } = renderModal(
      ACTIVATION_PROGRESS_ALL_DONE,
      "all-done",
    );
    expect(getByText("You did it!")).not.toBeNull();
    expect(queryByText("Welcome!")).toBeNull();
    expect(
      getByText(
        "Three tasks down. The full list is here whenever you want more.",
      ),
    ).not.toBeNull();
  });

  test("the celebration navigates to the list and closes", () => {
    let dismissals = 0;
    const { getByRole, getByTestId } = renderModal(
      ACTIVATION_PROGRESS_ALL_DONE,
      "all-done",
      () => {
        dismissals += 1;
      },
    );
    fireEvent.click(getByRole("button", { name: "Show me the full list" }));
    expect(dismissals).toBe(1);
    expect(getByTestId("location").textContent).toBe("/assistant/suggestions");
  });
});
