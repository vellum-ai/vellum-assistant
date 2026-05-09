import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Unit tests for the inline `acp_spawn` tap-to-open shortcut wired up on
/// the chat-side `ToolCallStepDetailRow`. The view itself is tested only
/// through its pure helpers (no SwiftUI view tree spun up) — pixel-level
/// rendering is covered indirectly by the existing
/// ``ACPSessionsPanelTests`` end-to-end coverage.
///
/// The `applyACPSessionDeepLink` tests mutate `MainWindowState`'s persisted
/// layout config (the on-disk `layout-config.json`). We snapshot the file
/// in `setUp` and restore in `tearDown` so the developer's local app
/// state isn't trashed by running the suite.
@MainActor
final class ChatBubbleACPSpawnTests: XCTestCase {
    private var layoutConfigBackup: Data?
    private var layoutConfigExisted = false
    private var codingAgentsPanelOverrideExisted = false
    private var codingAgentsPanelOverrideValue = false

    override func setUpWithError() throws {
        try super.setUpWithError()
        let url = Self.layoutConfigURL()
        layoutConfigExisted = FileManager.default.fileExists(atPath: url.path)
        if layoutConfigExisted {
            layoutConfigBackup = try Data(contentsOf: url)
        }
        let defaultsKey = Self.codingAgentsPanelDefaultsKey()
        codingAgentsPanelOverrideExisted = SharedUserDefaults.standard.object(forKey: defaultsKey) != nil
        codingAgentsPanelOverrideValue = SharedUserDefaults.standard.bool(forKey: defaultsKey)
        MacOSClientFeatureFlagManager.shared.setOverride(CodingAgentsPanelFeatureFlag.key, enabled: true)
    }

    override func tearDownWithError() throws {
        if codingAgentsPanelOverrideExisted {
            MacOSClientFeatureFlagManager.shared.setOverride(
                CodingAgentsPanelFeatureFlag.key,
                enabled: codingAgentsPanelOverrideValue
            )
        } else {
            MacOSClientFeatureFlagManager.shared.removeOverride(CodingAgentsPanelFeatureFlag.key)
        }
        codingAgentsPanelOverrideExisted = false
        codingAgentsPanelOverrideValue = false

        let url = Self.layoutConfigURL()
        if layoutConfigExisted, let data = layoutConfigBackup {
            try data.write(to: url, options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: url)
        }
        layoutConfigBackup = nil
        layoutConfigExisted = false
        try super.tearDownWithError()
    }

    /// Mirrors `LayoutConfigStore.configURL` — keep this in sync if the
    /// production path changes. Hard-coded so the tests don't reach into
    /// the production enum's `private` static.
    private static func layoutConfigURL() -> URL {
        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!
        return appSupport
            .appendingPathComponent(VellumEnvironment.current.appSupportDirectoryName, isDirectory: true)
            .appendingPathComponent("layout-config.json")
    }

    private static func codingAgentsPanelDefaultsKey() -> String {
        "MacOSFeatureFlag.codingagentspanel"
    }

    // MARK: - extractAcpSessionId
    //
    // The parser lives in shared code (`ToolCallProgressBar.extractAcpSessionId`)
    // so iOS and macOS accept identical `acp_spawn` payload shapes. These
    // tests exercise the shared helper rather than a per-platform copy.

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
    /// the standard collapsible layout (with technical details visible) —
    /// silently rendering an unparseable row as a tap-to-open card would
    /// strand the user on a broken link.
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

    func test_acpSessionIdToOpen_isNilWhenCodingAgentsPanelFlagDisabled() {
        MacOSClientFeatureFlagManager.shared.setOverride(CodingAgentsPanelFeatureFlag.key, enabled: false)
        let toolCall = ToolCallData(
            toolName: "acp_spawn",
            inputSummary: "spawn",
            result: #"{"acpSessionId":"acp-disabled"}"#,
            isComplete: true
        )
        let row = ToolCallStepDetailRow(
            toolCall: toolCall,
            phase: .complete,
            isDetailExpanded: .constant(false)
        )

        XCTAssertNil(
            row.acpSessionIdToOpen,
            "Disabled panel flag must force acp_spawn rows through the ordinary expandable tool-row path"
        )
    }

    func test_acpSessionIdToOpen_returnsIdWhenCodingAgentsPanelFlagEnabled() {
        MacOSClientFeatureFlagManager.shared.setOverride(CodingAgentsPanelFeatureFlag.key, enabled: true)
        let toolCall = ToolCallData(
            toolName: "acp_spawn",
            inputSummary: "spawn",
            result: #"{"acpSessionId":"acp-enabled"}"#,
            isComplete: true
        )
        let row = ToolCallStepDetailRow(
            toolCall: toolCall,
            phase: .complete,
            isDetailExpanded: .constant(false)
        )

        XCTAssertEqual(row.acpSessionIdToOpen, "acp-enabled")
    }

    // MARK: - applyACPSessionDeepLink

    /// End-to-end of the deep-link side effects: the right slot flips to
    /// `.native(.acpSessions)` with `visible: true`, and the store's
    /// `selectedSessionId` carries the requested id (the panel consumes it
    /// on its next observation tick).
    func test_applyACPSessionDeepLink_setsRightSlotAndStoreId() {
        let windowState = MainWindowState()
        // Reset the right slot to a known-empty pre-state so the assertion
        // below isn't tainted by whatever ``LayoutConfigStore.load`` rehydrated
        // from a previous test (or a developer's local app run). This is a
        // pure test-fixture override — production callers go through
        // `applyLayoutConfig` / `showRightSlot`.
        windowState.layoutConfig.right = SlotConfig(content: .empty, width: 400, visible: false)
        let store = ACPSessionStore()
        XCTAssertNil(store.selectedSessionId)

        ToolCallStepDetailRow.applyACPSessionDeepLink(
            id: "acp-target-id",
            windowState: windowState,
            store: store
        )

        XCTAssertEqual(
            windowState.layoutConfig.right.content,
            .native(.acpSessions),
            "Right slot must be flipped to the Coding Agents panel"
        )
        XCTAssertTrue(
            windowState.layoutConfig.right.visible,
            "Right slot must be made visible so the panel actually renders"
        )
        XCTAssertEqual(
            store.selectedSessionId,
            "acp-target-id",
            "Store must carry the requested session id so the panel can push the matching detail view"
        )
    }

    /// Width is preserved when flipping the right slot — the user's
    /// chosen panel size from a prior interaction should not be reset to
    /// the default just because we're swapping content.
    func test_applyACPSessionDeepLink_preservesPersistedRightSlotWidth() {
        let windowState = MainWindowState()
        windowState.layoutConfig.right = SlotConfig(
            content: .empty,
            width: 512,
            visible: false
        )
        let store = ACPSessionStore()

        ToolCallStepDetailRow.applyACPSessionDeepLink(
            id: "acp-target",
            windowState: windowState,
            store: store
        )

        XCTAssertEqual(windowState.layoutConfig.right.width, 512)
    }

    func test_applyACPSessionDeepLink_isNoOpWhenCodingAgentsPanelFlagDisabled() {
        MacOSClientFeatureFlagManager.shared.setOverride(CodingAgentsPanelFeatureFlag.key, enabled: false)
        let windowState = MainWindowState()
        windowState.layoutConfig.right = SlotConfig(content: .empty, width: 512, visible: false)
        let store = ACPSessionStore()

        ToolCallStepDetailRow.applyACPSessionDeepLink(
            id: "acp-disabled",
            windowState: windowState,
            store: store
        )

        XCTAssertEqual(
            windowState.layoutConfig.right,
            SlotConfig(content: .empty, width: 512, visible: false),
            "Disabled panel flag must not mutate persisted right-slot layout"
        )
        XCTAssertNil(
            store.selectedSessionId,
            "Disabled panel flag must not select a session for the hidden panel"
        )
    }

    /// Either the window state or the store being nil must short-circuit
    /// the deep link without crashing. `AppDelegate.shared?.mainWindow` is
    /// nil during early launch and inside background helpers, so the
    /// guard is a real production path, not just defensive cosmetics.
    func test_applyACPSessionDeepLink_isNoOpWhenWindowStateOrStoreIsNil() {
        let windowState = MainWindowState()
        // Override persisted layout so prior runs don't bleed into this
        // test's assertions on right-slot mutation.
        windowState.layoutConfig.right = SlotConfig(content: .empty, width: 400, visible: false)
        let store = ACPSessionStore()

        ToolCallStepDetailRow.applyACPSessionDeepLink(
            id: "acp-id",
            windowState: nil,
            store: store
        )
        XCTAssertNil(store.selectedSessionId, "Store must not be touched when windowState is nil")
        XCTAssertEqual(windowState.layoutConfig.right.content, .empty)

        ToolCallStepDetailRow.applyACPSessionDeepLink(
            id: "acp-id",
            windowState: windowState,
            store: nil
        )
        XCTAssertEqual(
            windowState.layoutConfig.right.content,
            .empty,
            "Right slot must not be touched when store is nil"
        )
    }

    // MARK: - ACPSessionsPanel deep-link consumption

    /// When `selectedSessionId` matches a session already in the store,
    /// invoking the consume helper pushes that view model onto the panel's
    /// navigation path. The store's field is cleared on consume so a
    /// repeated set-with-same-id still triggers a fresh push.
    func test_acpSessionsPanel_consumesSelectedSessionIdAndPushesDetail() {
        let store = ACPSessionStore()
        // Spawn synthesizes state.id == state.acpSessionId. Diverge them
        // afterward so the assertion below pins the
        // store-keyed-by-`state.id` contract — a regression that re-keyed
        // by `state.acpSessionId` would fail this test instead of silently
        // passing.
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: "acp-deep-link",
            agent: "claude-code",
            parentConversationId: "conv-deep"
        )))
        if let viewModel = store.sessions["acp-deep-link"] {
            viewModel.state = ACPSessionState(
                id: "acp-deep-link",
                agentId: "claude-code",
                acpSessionId: "protocol-acp-deep-link",
                parentConversationId: "conv-deep",
                status: .running,
                startedAt: viewModel.state.startedAt
            )
        }

        var path: [ACPSessionViewModel] = []
        store.selectedSessionId = "acp-deep-link"
        ACPSessionsPanel.consumeSelectedSessionIdIfPresent(store: store, path: &path)

        XCTAssertEqual(path.count, 1, "Detail view must be pushed onto the panel's NavigationStack")
        XCTAssertEqual(
            path.last?.state.id,
            "acp-deep-link",
            "Pushed view model must match the requested session by daemon UUID (state.id)"
        )
        XCTAssertNil(
            store.selectedSessionId,
            "selectedSessionId must be cleared after the panel consumes it so a later set still fires a push"
        )
    }

    /// If the requested id has no matching row yet (e.g. the deep link
    /// landed before the SSE `acp_session_spawned` event), consume must
    /// be a no-op so the user lands on the list and the field stays set
    /// for a later arrival to flush.
    func test_acpSessionsPanel_consumeIsNoOpWhenSessionMissing() {
        let store = ACPSessionStore()
        var path: [ACPSessionViewModel] = []
        store.selectedSessionId = "acp-not-yet-spawned"

        ACPSessionsPanel.consumeSelectedSessionIdIfPresent(store: store, path: &path)

        XCTAssertEqual(path.count, 0, "No push when the session row doesn't exist yet")
        XCTAssertEqual(
            store.selectedSessionId,
            "acp-not-yet-spawned",
            "Field must stay set so a later spawn + re-trigger can still flush the deep link"
        )
    }

    /// Pushing the same view model twice in a row must collapse to one
    /// push so a re-tap on the same `acp_spawn` block doesn't stack
    /// duplicate detail views on top of each other.
    func test_acpSessionsPanel_consumeIsIdempotentForSameTopOfStack() {
        let store = ACPSessionStore()
        // Diverge state.id and state.acpSessionId so the consume path is
        // exercised under the realistic post-`createSession` shape.
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: "acp-same",
            agent: "codex",
            parentConversationId: "conv-x"
        )))
        if let viewModel = store.sessions["acp-same"] {
            viewModel.state = ACPSessionState(
                id: "acp-same",
                agentId: "codex",
                acpSessionId: "protocol-acp-same",
                parentConversationId: "conv-x",
                status: .running,
                startedAt: viewModel.state.startedAt
            )
        }

        var path: [ACPSessionViewModel] = []

        store.selectedSessionId = "acp-same"
        ACPSessionsPanel.consumeSelectedSessionIdIfPresent(store: store, path: &path)
        XCTAssertEqual(path.count, 1)

        // Re-triggering with the same id must not stack a duplicate row.
        store.selectedSessionId = "acp-same"
        ACPSessionsPanel.consumeSelectedSessionIdIfPresent(store: store, path: &path)
        XCTAssertEqual(
            path.count,
            1,
            "Re-tapping the same session must not stack duplicate detail views"
        )
    }

    // MARK: - ACPSpawnStatusIndicator

    /// `.running` and `.initializing` are both "still working" from the
    /// user's perspective — neither is a terminal state they can act on,
    /// so the inline block must show the same pulsing dot for both. If
    /// `.initializing` ever rendered as a static glyph the user would
    /// misread a session that just started as already done.
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

    /// Successful terminal — green check. This is the dominant path for
    /// the inline block (most sessions complete normally) so the visual
    /// must read as a positive confirmation, not a generic neutral icon.
    func test_acpSpawnStatusIndicator_completedRendersPositiveCheck() {
        XCTAssertEqual(
            ACPSpawnStatusIndicator.resolve(forStatus: .completed),
            .icon(glyph: .check, role: .positive)
        )
    }

    /// Errored terminal — red x. The inline block normally falls back to
    /// the regular collapsible row when the spawn tool itself errored,
    /// but a session can still flip to `.failed` *after* the spawn
    /// returned successfully (daemon-side process crash, agent error)
    /// so the live indicator must surface that as a clear negative.
    func test_acpSpawnStatusIndicator_failedRendersNegativeXmark() {
        XCTAssertEqual(
            ACPSpawnStatusIndicator.resolve(forStatus: .failed),
            .icon(glyph: .xmark, role: .negative)
        )
    }

    /// Cancelled terminal — muted dash. Cancellation is user-initiated
    /// (or a parent shutdown) and isn't an error, so it gets the gray
    /// muted role rather than the red one used for `.failed`.
    func test_acpSpawnStatusIndicator_cancelledRendersMutedDash() {
        XCTAssertEqual(
            ACPSpawnStatusIndicator.resolve(forStatus: .cancelled),
            .icon(glyph: .dash, role: .muted)
        )
    }

    /// `.unknown` arrives only via daemon version skew. We treat it as a
    /// successful completion because the inline block only renders for
    /// `acp_spawn` results that already returned a session id, so the
    /// row's mere existence is evidence the spawn worked. Pulsing
    /// indefinitely on a status the client doesn't recognize would
    /// strand the user on a stuck-looking row.
    func test_acpSpawnStatusIndicator_unknownStatusFallsBackToCompleted() {
        XCTAssertEqual(
            ACPSpawnStatusIndicator.resolve(forStatus: .unknown),
            .icon(glyph: .check, role: .positive)
        )
    }

    /// Nil (no entry in the store) falls back to a muted dashed glyph.
    /// Two cases land here — the spawn-event race window before the store
    /// observes `acp_session_spawned`, and history-cleared-after-success.
    /// Neither justifies a positive terminal check: the race case would
    /// flip backward to pulsing once the entry arrives, and the cleared
    /// case can no longer prove the session's terminal disposition. A
    /// muted indeterminate glyph honestly conveys "we don't know" without
    /// pulsing indefinitely.
    func test_acpSpawnStatusIndicator_missingStoreEntryFallsBackToMuted() {
        XCTAssertEqual(
            ACPSpawnStatusIndicator.resolve(forStatus: nil),
            .icon(glyph: .dash, role: .muted)
        )
    }

    /// End-to-end scenario the PR is meant to enable: a running session
    /// flips to completed and the indicator switches from pulsing to
    /// the positive check without any view-side input. Drives through
    /// the same `ACPSessionStore.handle` pipeline production code uses
    /// so the test catches regressions in either the resolver or the
    /// store's status-transition logic.
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
}
