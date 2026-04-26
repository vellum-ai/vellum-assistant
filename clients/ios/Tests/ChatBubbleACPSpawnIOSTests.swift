#if canImport(UIKit)
import SwiftUI
import XCTest

@testable import VellumAssistantShared
@testable import vellum_assistant_ios

/// Unit tests for the inline `acp_spawn` tap-to-open shortcut wired up in
/// `ToolCallProgressBar` on iOS. The view itself is exercised only through
/// pure helpers (no SwiftUI view tree spun up) — pixel-level rendering is
/// covered indirectly by the existing ``ACPSessionsViewIOSTests`` end-to-end
/// coverage.
@MainActor
final class ChatBubbleACPSpawnIOSTests: XCTestCase {

    // MARK: - extractAcpSessionId

    /// Happy path: the tool returns a JSON object with `acpSessionId` set.
    /// We must surface exactly that string so the deep link lands on the
    /// matching session row.
    func test_extractAcpSessionId_returnsIdFromCanonicalPayload() {
        let payload = #"{"acpSessionId":"acp-abc-123","protocolSessionId":"proto-x","agent":"claude","cwd":"/tmp","status":"running","message":"…"}"#
        XCTAssertEqual(
            ToolCallProgressBar.extractAcpSessionId(from: payload),
            "acp-abc-123"
        )
    }

    /// The daemon appends an outdated-adapter warning after a blank line
    /// in some payloads (see `assistant/src/tools/acp/spawn.ts`). The
    /// parser scans only the leading line so the deep link still lights
    /// up in that case — losing the affordance just because the user has
    /// an out-of-date adapter installed would be a frustrating regression.
    func test_extractAcpSessionId_returnsIdEvenWithTrailingWarningLines() {
        let payload = """
        {"acpSessionId":"acp-xyz-789","protocolSessionId":"proto","agent":"claude","cwd":"/tmp","status":"running","message":"…"}

        Note: claude-agent-acp is outdated (installed: 1.0.0, latest: 1.1.0).
        """
        XCTAssertEqual(
            ToolCallProgressBar.extractAcpSessionId(from: payload),
            "acp-xyz-789"
        )
    }

    /// Empty / malformed payloads must return nil so the row falls back to
    /// the standard step bar (with technical details visible) — silently
    /// rendering an unparseable row as a tap-to-open card would strand the
    /// user on a broken link.
    func test_extractAcpSessionId_returnsNilForEmptyOrMalformedJson() {
        XCTAssertNil(ToolCallProgressBar.extractAcpSessionId(from: ""))
        XCTAssertNil(ToolCallProgressBar.extractAcpSessionId(from: "not-json"))
        XCTAssertNil(ToolCallProgressBar.extractAcpSessionId(from: "{"))
    }

    /// A JSON object that doesn't carry `acpSessionId` (e.g. an error
    /// payload) must be treated as "no deep link" — same fallback as
    /// malformed JSON.
    func test_extractAcpSessionId_returnsNilWhenFieldMissing() {
        let payload = #"{"error":"binary not found","agent":"claude"}"#
        XCTAssertNil(ToolCallProgressBar.extractAcpSessionId(from: payload))
    }

    /// `acpSessionId` exists but is empty — also treated as no link, since
    /// the panel keys its `sessions` dictionary by id and an empty string
    /// would never resolve.
    func test_extractAcpSessionId_returnsNilForEmptyIdString() {
        let payload = #"{"acpSessionId":"","agent":"claude"}"#
        XCTAssertNil(ToolCallProgressBar.extractAcpSessionId(from: payload))
    }

    /// A non-string `acpSessionId` (number, null) must not crash the parse
    /// or coerce to a stringified value — it must surface as nil so the
    /// fallback row renders.
    func test_extractAcpSessionId_returnsNilForNonStringIdValues() {
        XCTAssertNil(ToolCallProgressBar.extractAcpSessionId(from: #"{"acpSessionId":42}"#))
        XCTAssertNil(ToolCallProgressBar.extractAcpSessionId(from: #"{"acpSessionId":null}"#))
    }

    // MARK: - applyACPSessionDeepLink

    /// End-to-end of the deep-link side effect: the store's
    /// `selectedSessionId` carries the requested id (the sheet consumes
    /// it on its next observation tick).
    func test_applyACPSessionDeepLink_setsStoreSelectedSessionId() {
        let store = ACPSessionStore()
        XCTAssertNil(store.selectedSessionId)

        ACPSpawnDeepLinkCard.applyACPSessionDeepLink(
            id: "acp-target-id",
            store: store
        )

        XCTAssertEqual(
            store.selectedSessionId,
            "acp-target-id",
            "Store must carry the requested session id so the sheet can push the matching detail view"
        )
    }

    /// A nil store must short-circuit the deep link without crashing.
    /// `ACPSpawnAppDelegateBridge.shared` is nil during early launch and
    /// inside background helpers, so the guard is a real production
    /// path, not just defensive cosmetics.
    func test_applyACPSessionDeepLink_isNoOpWhenStoreIsNil() {
        // No assertion needed beyond "this didn't crash" — the helper
        // returns void and a nil store has no observable side effect.
        ACPSpawnDeepLinkCard.applyACPSessionDeepLink(id: "acp-id", store: nil)
    }

    // MARK: - statusLabel

    /// Running spawns map to "Running" so the secondary text under the
    /// tool name communicates live state. Mirrors macOS's "Running"
    /// label inside `AssistantProgressView`.
    func test_statusLabel_runningWhenIncomplete() {
        let toolCall = makeAcpSpawnToolCall(isComplete: false, isError: false)
        XCTAssertEqual(ACPSpawnDeepLinkCard.statusLabel(for: toolCall), "Running")
    }

    /// Completed and successful spawns map to "Completed".
    func test_statusLabel_completedWhenSuccessful() {
        let toolCall = makeAcpSpawnToolCall(isComplete: true, isError: false)
        XCTAssertEqual(ACPSpawnDeepLinkCard.statusLabel(for: toolCall), "Completed")
    }

    /// Error spawns map to "Failed" regardless of completion state.
    /// We allow the deep-link card to render for errors so the user can
    /// jump in to see the failure mode — the indicator turns red.
    func test_statusLabel_failedWhenErrored() {
        let toolCall = makeAcpSpawnToolCall(isComplete: true, isError: true)
        XCTAssertEqual(ACPSpawnDeepLinkCard.statusLabel(for: toolCall), "Failed")
    }

    // MARK: - ACPSessionsView deep-link consumption (compact)

    /// When `selectedSessionId` matches a session already in the store,
    /// invoking the consume helper pushes that id onto the panel's
    /// navigation path on compact (iPhone). The store's field is cleared
    /// on consume so a repeated set-with-same-id still triggers a fresh
    /// push.
    func test_acpSessionsView_consumesSelectedSessionIdAndPushesDetail_compact() {
        let store = ACPSessionStore()
        injectFixture(into: store, acpSessionId: "acp-deep-link", agentId: "claude-code")

        var path: [String] = []
        var selected: String?
        store.selectedSessionId = "acp-deep-link"

        ACPSessionsView.consumeSelectedSessionIdIfPresent(
            store: store,
            isCompact: true,
            selected: &selected,
            path: &path
        )

        XCTAssertEqual(path, ["acp-deep-link"], "Detail view must be pushed onto compact NavigationStack")
        XCTAssertNil(
            store.selectedSessionId,
            "selectedSessionId must be cleared after consume so a later set still fires a push"
        )
    }

    /// Regular (iPad) consumes the deep link by setting the split-view
    /// selection, not by pushing onto the path. Mirrors the
    /// `List(selection:)` binding the regular-size-class layout uses.
    func test_acpSessionsView_consumesSelectedSessionIdAndSelectsDetail_regular() {
        let store = ACPSessionStore()
        injectFixture(into: store, acpSessionId: "acp-deep-link", agentId: "codex")

        var path: [String] = []
        var selected: String?
        store.selectedSessionId = "acp-deep-link"

        ACPSessionsView.consumeSelectedSessionIdIfPresent(
            store: store,
            isCompact: false,
            selected: &selected,
            path: &path
        )

        XCTAssertEqual(selected, "acp-deep-link", "Selection binding must carry the deep-link id on regular")
        XCTAssertEqual(path, [], "Path must remain empty on regular — selection drives the detail pane")
        XCTAssertNil(store.selectedSessionId)
    }

    /// If the requested id has no matching row yet (e.g. the deep link
    /// landed before the SSE `acp_session_spawned` event), consume must
    /// be a no-op so the user lands on the list and the field stays set
    /// for a later arrival to flush.
    func test_acpSessionsView_consumeIsNoOpWhenSessionMissing() {
        let store = ACPSessionStore()
        var path: [String] = []
        var selected: String?
        store.selectedSessionId = "acp-not-yet-spawned"

        ACPSessionsView.consumeSelectedSessionIdIfPresent(
            store: store,
            isCompact: true,
            selected: &selected,
            path: &path
        )

        XCTAssertEqual(path, [], "No push when the session row doesn't exist yet")
        XCTAssertNil(selected)
        XCTAssertEqual(
            store.selectedSessionId,
            "acp-not-yet-spawned",
            "Field must stay set so a later spawn + re-trigger can still flush the deep link"
        )
    }

    /// Pushing the same id twice in a row must collapse to one push so
    /// a re-tap on the same `acp_spawn` block doesn't stack duplicate
    /// detail views on top of each other.
    func test_acpSessionsView_consumeIsIdempotentForSameTopOfStack_compact() {
        let store = ACPSessionStore()
        injectFixture(into: store, acpSessionId: "acp-same", agentId: "codex")

        var path: [String] = []
        var selected: String?

        store.selectedSessionId = "acp-same"
        ACPSessionsView.consumeSelectedSessionIdIfPresent(
            store: store,
            isCompact: true,
            selected: &selected,
            path: &path
        )
        XCTAssertEqual(path, ["acp-same"])

        // Re-triggering with the same id must not stack a duplicate row.
        store.selectedSessionId = "acp-same"
        ACPSessionsView.consumeSelectedSessionIdIfPresent(
            store: store,
            isCompact: true,
            selected: &selected,
            path: &path
        )
        XCTAssertEqual(
            path,
            ["acp-same"],
            "Re-tapping the same session must not stack duplicate detail views"
        )
    }

    /// Same idempotence guarantee on regular (iPad): re-selecting the
    /// already-selected detail must not flicker the selection binding.
    func test_acpSessionsView_consumeIsIdempotentForSameSelection_regular() {
        let store = ACPSessionStore()
        injectFixture(into: store, acpSessionId: "acp-same", agentId: "claude-code")

        var path: [String] = []
        var selected: String? = "acp-same"

        store.selectedSessionId = "acp-same"
        ACPSessionsView.consumeSelectedSessionIdIfPresent(
            store: store,
            isCompact: false,
            selected: &selected,
            path: &path
        )

        XCTAssertEqual(selected, "acp-same")
        XCTAssertNil(
            store.selectedSessionId,
            "Field must still be cleared so a later set with a different id will fire"
        )
    }

    // MARK: - Status transitions update indicator state

    /// The indicator's pulse-vs-check behavior is driven entirely by
    /// `toolCall.isComplete` / `toolCall.isError`, so verifying the
    /// status label flips alongside the underlying state is enough to
    /// pin the contract — view-level rendering is out of scope.
    func test_statusTransitions_updateLabelAcrossLifecycle() {
        var toolCall = makeAcpSpawnToolCall(isComplete: false, isError: false)
        XCTAssertEqual(ACPSpawnDeepLinkCard.statusLabel(for: toolCall), "Running")

        toolCall.isComplete = true
        XCTAssertEqual(ACPSpawnDeepLinkCard.statusLabel(for: toolCall), "Completed")

        toolCall.isError = true
        XCTAssertEqual(ACPSpawnDeepLinkCard.statusLabel(for: toolCall), "Failed")
    }

    // MARK: - Shared resolver wiring (live store)

    /// `.running` and `.initializing` are both "still working" from the
    /// user's perspective — neither is a terminal state they can act on,
    /// so the inline block must show the same pulsing dot for both.
    /// Mirrors the macOS test of the same name; both platforms now drive
    /// off the same shared resolver.
    func test_acpSpawnStatusIndicator_pulsesWhileRunningOrInitializing() {
        XCTAssertEqual(
            ACPSpawnStatusIndicator.resolve(forStatus: .running),
            .pulsing
        )
        XCTAssertEqual(
            ACPSpawnStatusIndicator.resolve(forStatus: .initializing),
            .pulsing
        )
    }

    /// Successful terminal — green check.
    func test_acpSpawnStatusIndicator_completedRendersPositiveCheck() {
        XCTAssertEqual(
            ACPSpawnStatusIndicator.resolve(forStatus: .completed),
            .icon(glyph: .check, role: .positive)
        )
    }

    /// Errored terminal — red x.
    func test_acpSpawnStatusIndicator_failedRendersNegativeXmark() {
        XCTAssertEqual(
            ACPSpawnStatusIndicator.resolve(forStatus: .failed),
            .icon(glyph: .xmark, role: .negative)
        )
    }

    /// Cancelled terminal — muted dash.
    func test_acpSpawnStatusIndicator_cancelledRendersMutedDash() {
        XCTAssertEqual(
            ACPSpawnStatusIndicator.resolve(forStatus: .cancelled),
            .icon(glyph: .dash, role: .muted)
        )
    }

    /// `.unknown` arrives only via daemon version skew — treat as
    /// completed since the row only renders when the spawn already
    /// returned a session id.
    func test_acpSpawnStatusIndicator_unknownStatusFallsBackToCompleted() {
        XCTAssertEqual(
            ACPSpawnStatusIndicator.resolve(forStatus: .unknown),
            .icon(glyph: .check, role: .positive)
        )
    }

    /// Nil status (history cleared, daemon restarted) falls through to
    /// the static "completed" check — same fallback as `.unknown`.
    func test_acpSpawnStatusIndicator_missingStoreEntryFallsBackToCompleted() {
        XCTAssertEqual(
            ACPSpawnStatusIndicator.resolve(forStatus: nil),
            .icon(glyph: .check, role: .positive)
        )
    }

    /// Live transition: a running session flips to completed and the
    /// indicator switches from pulsing to the positive check without any
    /// view-side input. This is the gap fix-r1-5 closes — before this
    /// PR, iOS read `toolCall.isComplete` directly and missed live
    /// running → completed transitions emitted via `ACPSessionStore`.
    func test_acpSpawnStatusIndicator_transitionsFromRunningToCompletedViaStore() {
        let store = ACPSessionStore()
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: "acp-live",
            agent: "claude-code",
            parentConversationId: "conv-live"
        )))

        XCTAssertEqual(
            ACPSpawnStatusIndicator.resolve(
                forStatus: store.sessions["acp-live"]?.state.status
            ),
            .pulsing,
            "Newly spawned session must render pulsing while running"
        )

        store.handle(.acpSessionCompleted(ACPSessionCompletedMessage(
            acpSessionId: "acp-live",
            stopReason: .endTurn
        )))

        XCTAssertEqual(
            ACPSpawnStatusIndicator.resolve(
                forStatus: store.sessions["acp-live"]?.state.status
            ),
            .icon(glyph: .check, role: .positive),
            "Completed session must render the positive check"
        )
    }

    /// Mirror of the above for the failure path — `.failed` flowing
    /// through `acpSessionError` must surface as the negative red x.
    func test_acpSpawnStatusIndicator_transitionsFromRunningToFailedViaStore() {
        let store = ACPSessionStore()
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: "acp-fail",
            agent: "codex",
            parentConversationId: "conv-fail"
        )))

        store.handle(.acpSessionError(ACPSessionErrorMessage(
            acpSessionId: "acp-fail",
            error: "agent crashed"
        )))

        XCTAssertEqual(
            ACPSpawnStatusIndicator.resolve(
                forStatus: store.sessions["acp-fail"]?.state.status
            ),
            .icon(glyph: .xmark, role: .negative)
        )
    }

    /// Tool-call fallback used when the store has no entry for the
    /// requested session id — kicks in for early launch, test harnesses,
    /// or when the bridge isn't yet registered. Ensures iOS still
    /// renders a sensible terminal glyph even without a live store.
    func test_acpSpawnStatusIndicator_toolCallFallbackMapsToTerminalState() {
        let running = makeAcpSpawnToolCall(isComplete: false, isError: false)
        XCTAssertEqual(
            ACPSpawnStatusIndicator.resolve(forToolCall: running),
            .pulsing
        )

        let completed = makeAcpSpawnToolCall(isComplete: true, isError: false)
        XCTAssertEqual(
            ACPSpawnStatusIndicator.resolve(forToolCall: completed),
            .icon(glyph: .check, role: .positive)
        )

        let failed = makeAcpSpawnToolCall(isComplete: true, isError: true)
        XCTAssertEqual(
            ACPSpawnStatusIndicator.resolve(forToolCall: failed),
            .icon(glyph: .xmark, role: .negative)
        )
    }

    // MARK: - Helpers

    /// Synthetic `acp_spawn` tool call sized for the deep-link helpers.
    /// The result payload carries a parseable `acpSessionId` so the
    /// card-vs-bar split in `ToolCallProgressBar.body` resolves to the
    /// card path.
    private func makeAcpSpawnToolCall(
        isComplete: Bool,
        isError: Bool,
        sessionId: String = "acp-test"
    ) -> ToolCallData {
        let result = #"{"acpSessionId":"\#(sessionId)","agent":"claude","status":"running"}"#
        return ToolCallData(
            toolName: "acp_spawn",
            inputSummary: "claude",
            result: result,
            isError: isError,
            isComplete: isComplete
        )
    }

    /// Inserts a synthetic ACP session into the store via the same
    /// ``ServerMessage`` path the SSE pipeline uses. Matches the helper
    /// used in ``ACPSessionsViewIOSTests`` so fixtures behave the same
    /// across the two suites.
    private func injectFixture(
        into store: ACPSessionStore,
        acpSessionId: String,
        agentId: String
    ) {
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: acpSessionId,
            agent: agentId,
            parentConversationId: "conv-\(acpSessionId)"
        )))
    }
}
#endif
