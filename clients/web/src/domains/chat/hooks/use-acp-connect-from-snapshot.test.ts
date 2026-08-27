/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Re-raising the inline Connect card from the ACP snapshot.
 *
 * The snapshot row is the authoritative source: it carries the credential
 * failure, the conversation that owns it and the spawning tool call the card
 * anchors to, and the daemon clears the failure when a replacement token is
 * stored. These pin the rules the reopen path depends on.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { useInteractionStore } from "@/domains/chat/interaction-store";
import { ACP_CLAUDE_AUTH_REQUIRED_CODE } from "@/domains/chat/utils/acp-connect";
import { raiseAcpConnectFromSnapshot } from "@/domains/chat/hooks/use-acp-run-rehydration";

function run(overrides: Record<string, unknown> = {}) {
  return {
    acpSessionId: "acp-1",
    parentConversationId: "conv-1",
    parentToolUseId: "tool-1",
    status: "failed",
    authErrorCode: ACP_CLAUDE_AUTH_REQUIRED_CODE,
    ...overrides,
  } as any;
}

describe("raiseAcpConnectFromSnapshot", () => {
  beforeEach(() => {
    useInteractionStore.setState({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: new Set<string>(),
      acpConnectFlowActive: false,
    });
  });

  test("raises the card anchored to the run's spawn call and conversation", () => {
    raiseAcpConnectFromSnapshot([run()]);

    expect(useInteractionStore.getState().pendingAcpConnect).toEqual({
      toolUseId: "tool-1",
      reason: "auth_required",
      conversationId: "conv-1",
    });
  });

  test("ignores a run the daemon cleared the failure from", () => {
    // The clear happens on a replacement token write, which is what stops a
    // repaired rejection from re-raising on every reopen.
    raiseAcpConnectFromSnapshot([run({ authErrorCode: undefined })]);

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });

  test("ignores a run the user stopped", () => {
    raiseAcpConnectFromSnapshot([run({ status: "cancelled" })]);

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });

  test("ignores a run with no spawn call to anchor to", () => {
    raiseAcpConnectFromSnapshot([run({ parentToolUseId: undefined })]);

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });

  test("does not resurrect a prompt retired this session", () => {
    useInteractionStore.setState({
      dismissedAcpConnectToolUseIds: new Set(["tool-1"]),
    });

    raiseAcpConnectFromSnapshot([run()]);

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });

  test("the newest failure wins when the snapshot holds several", () => {
    // The snapshot arrives newest-first, so the newest marked run is the one
    // the loop must stop on. Ordered the way the route actually returns it.
    raiseAcpConnectFromSnapshot([
      run({ acpSessionId: "acp-2", parentToolUseId: "tool-new" }),
      run({ acpSessionId: "acp-1", parentToolUseId: "tool-old" }),
    ]);

    expect(useInteractionStore.getState().pendingAcpConnect?.toolUseId).toBe(
      "tool-new",
    );
  });

  test("skips ineligible newer rows to reach the newest marked one", () => {
    raiseAcpConnectFromSnapshot([
      run({ acpSessionId: "acp-3", authErrorCode: undefined }),
      run({ acpSessionId: "acp-2", parentToolUseId: "tool-new" }),
      run({ acpSessionId: "acp-1", parentToolUseId: "tool-old" }),
    ]);

    expect(useInteractionStore.getState().pendingAcpConnect?.toolUseId).toBe(
      "tool-new",
    );
  });
});

describe("raiseAcpConnectFromSnapshot: retiring a prompt the daemon dropped", () => {
  beforeEach(() => {
    useInteractionStore.setState({
      pendingAcpConnect: {
        toolUseId: "tool-1",
        reason: "auth_required",
        conversationId: "conv-1",
      },
      dismissedAcpConnectToolUseIds: new Set<string>(),
      acpConnectFlowActive: false,
    });
  });

  test("clears the prompt when the snapshot carries no marker", () => {
    // A client disconnected when the token landed never heard the
    // invalidation, and this prompt skips the connected-state self-heal, so
    // the reconnect snapshot is its only way to learn the card is stale.
    raiseAcpConnectFromSnapshot([run({ authErrorCode: undefined })], "conv-1");

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });

  test("clears the prompt on an empty snapshot", () => {
    raiseAcpConnectFromSnapshot([], "conv-1");

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });

  test("leaves a missing-token prompt alone, which the snapshot cannot speak for", () => {
    // Missing-token failures are not represented in ACP session history, so an
    // absent marker says nothing about them. Dismissing also records the
    // tool-use id, which would stop the transcript reseed from restoring the
    // card while the model's guidance still points at it.
    useInteractionStore.setState({
      pendingAcpConnect: {
        toolUseId: "tool-missing",
        reason: "missing",
        conversationId: "conv-1",
      },
    });

    raiseAcpConnectFromSnapshot([run({ authErrorCode: undefined })], "conv-1");

    expect(useInteractionStore.getState().pendingAcpConnect?.toolUseId).toBe(
      "tool-missing",
    );
  });

  test("leaves a prompt owned by another conversation alone", () => {
    raiseAcpConnectFromSnapshot([run({ authErrorCode: undefined })], "conv-2");

    expect(useInteractionStore.getState().pendingAcpConnect?.toolUseId).toBe(
      "tool-1",
    );
  });

  test("leaves the prompt alone while this tab owns a live Connect flow", () => {
    // The flow's own token write triggers the invalidation; clearing the card
    // underneath it loses the confirmation and the auto-continue it is about
    // to request.
    useInteractionStore.setState({ acpConnectFlowActive: true });

    raiseAcpConnectFromSnapshot([run({ authErrorCode: undefined })], "conv-1");

    expect(useInteractionStore.getState().pendingAcpConnect?.toolUseId).toBe(
      "tool-1",
    );
  });

  test("a still-marked run keeps the prompt rather than clearing it", () => {
    raiseAcpConnectFromSnapshot([run()]);

    expect(useInteractionStore.getState().pendingAcpConnect?.toolUseId).toBe(
      "tool-1",
    );
  });
});

describe("raiseAcpConnectFromSnapshot: snapshots older than the prompt", () => {
  test("does not retire a prompt raised after the fetch was issued", () => {
    // A snapshot requested before a live `acp_auth_required` can land after
    // it. Retiring on that would dismiss the prompt the daemon just raised and
    // record its tool-use id, so no later snapshot could restore the card.
    useInteractionStore.setState({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: new Set<string>(),
      acpConnectFlowActive: false,
    });
    const revisionAtFetch = useInteractionStore.getState().acpConnectRevision;

    // The live event lands while the fetch is in flight.
    useInteractionStore.getState().showAcpConnect({
      toolUseId: "tool-live",
      reason: "auth_required",
      conversationId: "conv-1",
    });

    raiseAcpConnectFromSnapshot(
      [run({ authErrorCode: undefined })],
      "conv-1",
      revisionAtFetch,
    );

    expect(useInteractionStore.getState().pendingAcpConnect?.toolUseId).toBe(
      "tool-live",
    );
    expect(
      useInteractionStore.getState().dismissedAcpConnectToolUseIds.size,
    ).toBe(0);
  });

  test("retires when the prompt has not changed since the fetch", () => {
    useInteractionStore.setState({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: new Set<string>(),
      acpConnectFlowActive: false,
    });
    useInteractionStore.getState().showAcpConnect({
      toolUseId: "tool-1",
      reason: "auth_required",
      conversationId: "conv-1",
    });
    const revisionAtFetch = useInteractionStore.getState().acpConnectRevision;

    raiseAcpConnectFromSnapshot(
      [run({ authErrorCode: undefined })],
      "conv-1",
      revisionAtFetch,
    );

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });
});

describe("raiseAcpConnectFromSnapshot: stale marked snapshots", () => {
  test("does not replace a newer prompt with an older marked run", () => {
    // Requested before a newer run failed, delivered after its live event
    // raised the newest anchor. Raising from it would walk the card back to
    // the older failure.
    useInteractionStore.setState({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: new Set<string>(),
      acpConnectFlowActive: false,
    });
    const revisionAtFetch = useInteractionStore.getState().acpConnectRevision;

    useInteractionStore.getState().showAcpConnect({
      toolUseId: "tool-newest",
      reason: "auth_required",
      conversationId: "conv-1",
    });

    raiseAcpConnectFromSnapshot(
      [run({ parentToolUseId: "tool-older" })],
      "conv-1",
      revisionAtFetch,
    );

    expect(useInteractionStore.getState().pendingAcpConnect?.toolUseId).toBe(
      "tool-newest",
    );
  });
});

describe("raiseAcpConnectFromSnapshot: a conversation switch mid-fetch", () => {
  test("a switch between the fetch and its response does not make an older snapshot look current", () => {
    // `resetAll` carries `pendingAcpConnect` across a conversation switch, so
    // the revision has to be carried with it. Restarting the counter at zero
    // lets a snapshot requested before the switch compare equal to the state
    // after it, which retires the live prompt and records its tool-use id, so
    // no later snapshot can restore the card either.
    useInteractionStore.setState({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: new Set<string>(),
      acpConnectFlowActive: false,
      acpConnectRevision: 0,
    });
    const revisionAtFetch = useInteractionStore.getState().acpConnectRevision;

    useInteractionStore.getState().showAcpConnect({
      toolUseId: "tool-live",
      reason: "auth_required",
      conversationId: "conv-1",
    });
    useInteractionStore.getState().resetAll();

    raiseAcpConnectFromSnapshot(
      [run({ authErrorCode: undefined })],
      "conv-1",
      revisionAtFetch,
    );

    expect(useInteractionStore.getState().pendingAcpConnect?.toolUseId).toBe(
      "tool-live",
    );
    expect(
      useInteractionStore.getState().dismissedAcpConnectToolUseIds.size,
    ).toBe(0);
  });
});

describe("raiseAcpConnectFromSnapshot: adopting an owner for an unowned prompt", () => {
  test("a stale snapshot still supplies the conversation the live event lacked", () => {
    // `acp_auth_required` is global and carries no conversation, so a client
    // that missed the run's spawn event records the prompt with none. An
    // unowned prompt renders only inline under its anchor row, so it is
    // unreachable once that row is outside the loaded transcript.
    useInteractionStore.setState({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: new Set<string>(),
      acpConnectFlowActive: false,
      acpConnectRevision: 0,
    });
    const revisionAtFetch = useInteractionStore.getState().acpConnectRevision;

    // The live event lands while the fetch is in flight, with no owner.
    useInteractionStore.getState().showAcpConnect({
      toolUseId: "tool-1",
      reason: "auth_required",
      conversationId: null,
    });

    raiseAcpConnectFromSnapshot([run()], "conv-1", revisionAtFetch);

    expect(useInteractionStore.getState().pendingAcpConnect).toMatchObject({
      toolUseId: "tool-1",
      conversationId: "conv-1",
    });
  });

  test("does not advance the revision, so reads in flight stay valid", () => {
    useInteractionStore.setState({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: new Set<string>(),
      acpConnectFlowActive: false,
      acpConnectRevision: 0,
    });
    const revisionAtFetch = useInteractionStore.getState().acpConnectRevision;
    useInteractionStore.getState().showAcpConnect({
      toolUseId: "tool-1",
      reason: "auth_required",
      conversationId: null,
    });
    const afterRaise = useInteractionStore.getState().acpConnectRevision;

    raiseAcpConnectFromSnapshot([run()], "conv-1", revisionAtFetch);

    expect(useInteractionStore.getState().acpConnectRevision).toBe(afterRaise);
  });

  test("leaves a prompt that already knows its conversation alone", () => {
    useInteractionStore.setState({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: new Set<string>(),
      acpConnectFlowActive: false,
      acpConnectRevision: 0,
    });
    const revisionAtFetch = useInteractionStore.getState().acpConnectRevision;
    useInteractionStore.getState().showAcpConnect({
      toolUseId: "tool-1",
      reason: "auth_required",
      conversationId: "conv-owned",
    });

    raiseAcpConnectFromSnapshot([run()], "conv-1", revisionAtFetch);

    expect(
      useInteractionStore.getState().pendingAcpConnect?.conversationId,
    ).toBe("conv-owned");
  });

  test("only adopts from the row that anchors this prompt", () => {
    // A stale snapshot may carry other runs. Matching on the tool-use id is
    // what keeps this from attributing the prompt to an unrelated failure.
    useInteractionStore.setState({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: new Set<string>(),
      acpConnectFlowActive: false,
      acpConnectRevision: 0,
    });
    const revisionAtFetch = useInteractionStore.getState().acpConnectRevision;
    useInteractionStore.getState().showAcpConnect({
      toolUseId: "tool-unmatched",
      reason: "auth_required",
      conversationId: null,
    });

    raiseAcpConnectFromSnapshot([run()], "conv-1", revisionAtFetch);

    expect(
      useInteractionStore.getState().pendingAcpConnect?.conversationId,
    ).toBeNull();
  });
});

describe("showAcpConnect: re-raising the same prompt is not a change", () => {
  test("an identical raise leaves the revision alone", () => {
    // Two fetches can capture the same revision. An older marked response
    // re-raising the prompt already displayed would advance it and make the
    // later authoritative one look stale, leaving a repaired card standing.
    useInteractionStore.setState({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: new Set<string>(),
      acpConnectFlowActive: false,
      acpConnectRevision: 0,
    });
    const payload = {
      toolUseId: "tool-1",
      reason: "auth_required" as const,
      conversationId: "conv-1",
    };
    useInteractionStore.getState().showAcpConnect(payload);
    const afterFirst = useInteractionStore.getState().acpConnectRevision;

    useInteractionStore.getState().showAcpConnect({ ...payload });

    expect(useInteractionStore.getState().acpConnectRevision).toBe(afterFirst);
  });

  test("a later unmarked snapshot can still retire after a duplicate raise", () => {
    // The consequence the revision guard protects: the authoritative response
    // captured the same revision and must still be allowed to retire.
    useInteractionStore.setState({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: new Set<string>(),
      acpConnectFlowActive: false,
      acpConnectRevision: 0,
    });
    useInteractionStore.getState().showAcpConnect({
      toolUseId: "tool-1",
      reason: "auth_required",
      conversationId: "conv-1",
    });
    const revisionAtFetch = useInteractionStore.getState().acpConnectRevision;

    // An older marked response re-raises what is already shown.
    useInteractionStore.getState().showAcpConnect({
      toolUseId: "tool-1",
      reason: "auth_required",
      conversationId: "conv-1",
    });
    // The authoritative unmarked snapshot lands next.
    raiseAcpConnectFromSnapshot([], "conv-1", revisionAtFetch);

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });

  test("a different anchor still counts as a change", () => {
    useInteractionStore.setState({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: new Set<string>(),
      acpConnectFlowActive: false,
      acpConnectRevision: 0,
    });
    useInteractionStore.getState().showAcpConnect({
      toolUseId: "tool-1",
      reason: "auth_required",
      conversationId: "conv-1",
    });
    const afterFirst = useInteractionStore.getState().acpConnectRevision;

    useInteractionStore.getState().showAcpConnect({
      toolUseId: "tool-2",
      reason: "auth_required",
      conversationId: "conv-1",
    });

    expect(useInteractionStore.getState().acpConnectRevision).toBe(
      afterFirst + 1,
    );
    expect(useInteractionStore.getState().pendingAcpConnect?.toolUseId).toBe(
      "tool-2",
    );
  });
});

describe("showAcpConnect: a live failure supersedes a dismissal", () => {
  test("a resumed run's second rejection raises the card again", () => {
    // `resumeFromHistory` carries the original spawning tool call, so a second
    // rejection arrives under the anchor whose card the user dismissed after
    // the first sign-in. Treating it as the dismissed one leaves a live
    // failure with no card while the daemon keeps redirecting prompts at one.
    useInteractionStore.setState({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: new Set<string>(["tool-resumed"]),
      acpConnectFlowActive: false,
      acpConnectRevision: 0,
    });

    useInteractionStore.getState().showAcpConnect(
      {
        toolUseId: "tool-resumed",
        reason: "auth_required",
        conversationId: "conv-1",
      },
      { supersedesDismissal: true },
    );

    expect(useInteractionStore.getState().pendingAcpConnect?.toolUseId).toBe(
      "tool-resumed",
    );
    // Forgotten with it, so a later restore of the same anchor is not
    // suppressed either.
    expect(
      useInteractionStore
        .getState()
        .dismissedAcpConnectToolUseIds.has("tool-resumed"),
    ).toBe(false);
  });

  test("a restored snapshot still respects the dismissal", () => {
    // Only a failure happening now supersedes. A reseed of the same history
    // must not resurrect what the user dismissed.
    useInteractionStore.setState({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: new Set<string>(["tool-dismissed"]),
      acpConnectFlowActive: false,
      acpConnectRevision: 0,
    });

    useInteractionStore.getState().showAcpConnect({
      toolUseId: "tool-dismissed",
      reason: "auth_required",
      conversationId: "conv-1",
    });

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });
});

describe("showAcpConnect: a flow in progress holds its own anchor", () => {
  test("a newer failure does not move the card mid-connect", () => {
    // Replacing the prompt moves the affordance to a different anchor row,
    // which unmounts the one that owns the OAuth flow. The loopback poll and
    // the manual paste state go with it, so a sign-in in progress cannot
    // finish.
    useInteractionStore.setState({
      pendingAcpConnect: {
        toolUseId: "tool-connecting",
        reason: "auth_required",
        conversationId: "conv-1",
      },
      dismissedAcpConnectToolUseIds: new Set<string>(),
      acpConnectFlowActive: true,
      acpConnectRevision: 0,
    });

    useInteractionStore.getState().showAcpConnect(
      {
        toolUseId: "tool-second-failure",
        reason: "auth_required",
        conversationId: "conv-1",
      },
      { supersedesDismissal: true },
    );

    expect(useInteractionStore.getState().pendingAcpConnect?.toolUseId).toBe(
      "tool-connecting",
    );
    expect(useInteractionStore.getState().acpConnectRevision).toBe(0);
  });

  test("the newer failure lands once the flow settles", () => {
    // Deferred, not dropped on the floor: the card clears when the flow ends,
    // and the newer failure carries its own marker for a snapshot to surface.
    useInteractionStore.setState({
      pendingAcpConnect: {
        toolUseId: "tool-connecting",
        reason: "auth_required",
        conversationId: "conv-1",
      },
      dismissedAcpConnectToolUseIds: new Set<string>(),
      acpConnectFlowActive: false,
      acpConnectRevision: 0,
    });

    useInteractionStore.getState().showAcpConnect({
      toolUseId: "tool-second-failure",
      reason: "auth_required",
      conversationId: "conv-1",
    });

    expect(useInteractionStore.getState().pendingAcpConnect?.toolUseId).toBe(
      "tool-second-failure",
    );
  });

  test("the connecting card's own updates still apply", () => {
    // Same anchor, so nothing moves; the guard must not freeze the flow out of
    // its own prompt.
    useInteractionStore.setState({
      pendingAcpConnect: {
        toolUseId: "tool-connecting",
        reason: "auth_required",
        conversationId: null,
      },
      dismissedAcpConnectToolUseIds: new Set<string>(),
      acpConnectFlowActive: true,
      acpConnectRevision: 0,
    });

    useInteractionStore.getState().showAcpConnect({
      toolUseId: "tool-connecting",
      reason: "auth_required",
      conversationId: "conv-1",
    });

    expect(
      useInteractionStore.getState().pendingAcpConnect?.conversationId,
    ).toBe("conv-1");
  });
});

describe("showAcpConnect: the flow guard runs before every replacement path", () => {
  test("a live event superseding a dismissal cannot move the card mid-connect", () => {
    // The supersede branch returns early, so a guard placed after it is one
    // the live path walks around. A resumed run reusing a dismissed anchor is
    // exactly that path.
    useInteractionStore.setState({
      pendingAcpConnect: {
        toolUseId: "tool-connecting",
        reason: "auth_required",
        conversationId: "conv-1",
      },
      dismissedAcpConnectToolUseIds: new Set<string>(["tool-resumed"]),
      acpConnectFlowActive: true,
      acpConnectRevision: 0,
    });

    useInteractionStore.getState().showAcpConnect(
      {
        toolUseId: "tool-resumed",
        reason: "auth_required",
        conversationId: "conv-1",
      },
      { supersedesDismissal: true },
    );

    expect(useInteractionStore.getState().pendingAcpConnect?.toolUseId).toBe(
      "tool-connecting",
    );
    // The dismissal is untouched too, so the deferred failure can still raise
    // its card once the flow settles.
    expect(
      useInteractionStore
        .getState()
        .dismissedAcpConnectToolUseIds.has("tool-resumed"),
    ).toBe(true);
  });

  test("with no flow running the supersede still works", () => {
    useInteractionStore.setState({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: new Set<string>(["tool-resumed"]),
      acpConnectFlowActive: false,
      acpConnectRevision: 0,
    });

    useInteractionStore.getState().showAcpConnect(
      {
        toolUseId: "tool-resumed",
        reason: "auth_required",
        conversationId: "conv-1",
      },
      { supersedesDismissal: true },
    );

    expect(useInteractionStore.getState().pendingAcpConnect?.toolUseId).toBe(
      "tool-resumed",
    );
  });
});
