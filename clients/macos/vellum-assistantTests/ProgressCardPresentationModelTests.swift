import Foundation
import Testing
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@Suite("ProgressCardPresentationModel")
struct ProgressCardPresentationModelTests {

    // MARK: - Helpers

    /// Creates a ToolCallData with a deterministic UUID for stable assertions.
    private static func makeToolCall(
        index: Int = 0,
        toolName: String = "edit_file",
        isComplete: Bool = false,
        isError: Bool = false,
        startedAt: Date? = Date(timeIntervalSince1970: 1000),
        completedAt: Date? = nil,
        confirmationDecision: ToolConfirmationState? = nil,
        pendingConfirmation: ToolConfirmationData? = nil,
        inputRawDict: [String: AnyCodable]? = nil
    ) -> ToolCallData {
        let id = UUID(uuidString: "00000000-0000-0000-0000-\(String(format: "%012d", index))")!
        var tc = ToolCallData(
            id: id,
            toolName: toolName,
            inputSummary: "test input \(index)",
            startedAt: startedAt,
            completedAt: completedAt
        )
        tc.isComplete = isComplete
        tc.isError = isError
        tc.confirmationDecision = confirmationDecision
        tc.pendingConfirmation = pendingConfirmation
        tc.inputRawDict = inputRawDict
        return tc
    }

    private static func makeConfirmation(
        requestId: String = "req-1",
        state: ToolConfirmationState = .pending
    ) -> ToolConfirmationData {
        var c = ToolConfirmationData(
            requestId: requestId,
            toolName: "run_command",
            riskLevel: "medium"
        )
        c.state = state
        return c
    }

    private static let idleContext = ProgressCardPresentationModel.StreamingContext.idle

    private static func streamingContext(
        isStreaming: Bool = false,
        hasText: Bool = false,
        isProcessing: Bool = false,
        streamingCodePreview: String? = nil
    ) -> ProgressCardPresentationModel.StreamingContext {
        .init(
            isStreaming: isStreaming,
            hasText: hasText,
            isProcessing: isProcessing,
            streamingCodePreview: streamingCodePreview
        )
    }

    // MARK: - Phase: Thinking

    @Test
    func emptyToolCallsIdleYieldsThinking() {
        let model = ProgressCardPresentationModel.build(
            toolCalls: [],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(model.phase == ProgressCardPhase.thinking)
        #expect(!model.hasTools)
        #expect(model.totalToolCount == 0)
        #expect(model.groupId == "no-tools")
    }

    // MARK: - Phase: Tool Running

    @Test
    func singleIncompleteToolYieldsToolRunning() {
        let tc = Self.makeToolCall(index: 1)
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(model.phase == ProgressCardPhase.toolRunning)
        #expect(model.hasTools)
        #expect(!model.allComplete)
        #expect(model.currentCall?.id == tc.id)
        #expect(model.totalToolCount == 1)
        #expect(model.completedToolCount == 0)
    }

    @Test
    func mixedCompletionYieldsToolRunning() {
        let tc1 = Self.makeToolCall(
            index: 1, isComplete: true,
            completedAt: Date(timeIntervalSince1970: 1001)
        )
        let tc2 = Self.makeToolCall(index: 2)
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc1, tc2],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(model.phase == ProgressCardPhase.toolRunning)
        #expect(model.completedToolCount == 1)
        #expect(model.currentCall?.id == tc2.id)
        #expect(model.lastIncompleteCall?.id == tc2.id)
    }

    // MARK: - Phase: Streaming Code

    @Test
    func streamingCodePreviewYieldsStreamingCode() {
        let tc = Self.makeToolCall(index: 1)
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.streamingContext(isStreaming: true, streamingCodePreview: "func hello() {}")
        )
        #expect(model.phase == ProgressCardPhase.streamingCode)
    }

    @Test
    func emptyCodePreviewDoesNotYieldStreamingCode() {
        let tc = Self.makeToolCall(index: 1)
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.streamingContext(isStreaming: true, streamingCodePreview: "")
        )
        // Empty preview should fall through to toolRunning (tool is incomplete)
        #expect(model.phase == ProgressCardPhase.toolRunning)
    }

    // MARK: - Phase: Tools Complete Thinking

    @Test
    func allCompleteStreamingNoTextYieldsToolsCompleteThinking() {
        let tc = Self.makeToolCall(
            index: 1, isComplete: true,
            completedAt: Date(timeIntervalSince1970: 1001)
        )
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.streamingContext(isStreaming: true, hasText: false)
        )
        #expect(model.phase == ProgressCardPhase.toolsCompleteThinking)
    }

    // MARK: - Phase: Processing

    @Test
    func allCompleteProcessingYieldsProcessing() {
        let tc = Self.makeToolCall(
            index: 1, isComplete: true,
            completedAt: Date(timeIntervalSince1970: 1001)
        )
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.streamingContext(isProcessing: true)
        )
        #expect(model.phase == ProgressCardPhase.processing)
    }

    @Test
    func noToolsStreamingYieldsProcessing() {
        let model = ProgressCardPresentationModel.build(
            toolCalls: [],
            decidedConfirmations: [],
            context: Self.streamingContext(isStreaming: true)
        )
        #expect(model.phase == ProgressCardPhase.processing)
    }

    @Test
    func noToolsProcessingYieldsProcessing() {
        let model = ProgressCardPresentationModel.build(
            toolCalls: [],
            decidedConfirmations: [],
            context: Self.streamingContext(isProcessing: true)
        )
        #expect(model.phase == ProgressCardPhase.processing)
    }

    // MARK: - Phase: Complete

    @Test
    func allCompleteNotStreamingYieldsComplete() {
        let tc = Self.makeToolCall(
            index: 1, isComplete: true,
            completedAt: Date(timeIntervalSince1970: 1001)
        )
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(model.phase == ProgressCardPhase.complete)
        #expect(model.allComplete)
        #expect(model.completedToolCount == 1)
    }

    @Test
    func allCompleteStreamingWithTextYieldsComplete() {
        let tc = Self.makeToolCall(
            index: 1, isComplete: true,
            completedAt: Date(timeIntervalSince1970: 1001)
        )
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.streamingContext(isStreaming: true, hasText: true)
        )
        #expect(model.phase == ProgressCardPhase.complete)
    }

    // MARK: - Phase: Denied

    @Test
    func deniedToolCallWithIncompleteYieldsDenied() {
        let tc = Self.makeToolCall(index: 1, confirmationDecision: .denied)
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(model.phase == ProgressCardPhase.denied)
        #expect(model.hasDeniedToolCalls)
        #expect(model.deniedCount == 1)
    }

    @Test
    func timedOutToolCallWithIncompleteYieldsDenied() {
        let tc = Self.makeToolCall(index: 1, confirmationDecision: .timedOut)
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(model.phase == ProgressCardPhase.denied)
        #expect(model.hasDeniedToolCalls)
        #expect(model.deniedCount == 1)
    }

    @Test
    func deniedFromDecidedConfirmationsFallback() {
        let tc = Self.makeToolCall(index: 1) // No confirmationDecision on call itself
        let denied = Self.makeConfirmation(state: .denied)
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [denied],
            context: Self.idleContext
        )
        #expect(model.hasDeniedToolCalls)
        // The denied fallback sets hasDeniedToolCalls, so with an incomplete tool
        // the phase resolves to denied.
        #expect(model.phase == ProgressCardPhase.denied)
    }

    @Test
    func deniedToolCallAllCompleteYieldsCompleteNotDenied() {
        // When all tools are complete (even if some were denied), the phase
        // should be .complete (with hasDeniedToolCalls = true for the warning icon).
        let tc = Self.makeToolCall(
            index: 1, isComplete: true,
            completedAt: Date(timeIntervalSince1970: 1001),
            confirmationDecision: .denied
        )
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(model.phase == ProgressCardPhase.complete)
        #expect(model.hasDeniedToolCalls)
        #expect(model.deniedCount == 1)
    }

    // MARK: - Denied takes precedence over streaming code

    @Test
    func deniedTakesPrecedenceOverStreamingCode() {
        let tc = Self.makeToolCall(index: 1, confirmationDecision: .denied)
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.streamingContext(isStreaming: true, streamingCodePreview: "code")
        )
        // Denied check comes before streamingCode check
        #expect(model.phase == ProgressCardPhase.denied)
    }

    // MARK: - Processing takes precedence over toolsCompleteThinking

    @Test
    func processingTakesPrecedenceOverToolsCompleteThinking() {
        let tc = Self.makeToolCall(
            index: 1, isComplete: true,
            completedAt: Date(timeIntervalSince1970: 1001)
        )
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.streamingContext(isStreaming: true, hasText: false, isProcessing: true)
        )
        // isProcessing should yield .processing even when streaming with no text
        #expect(model.phase == ProgressCardPhase.processing)
    }

    // MARK: - Completion Grouping

    @Test
    func multipleToolsGroupedCorrectly() {
        let tc1 = Self.makeToolCall(
            index: 1, toolName: "edit_file", isComplete: true,
            startedAt: Date(timeIntervalSince1970: 1000),
            completedAt: Date(timeIntervalSince1970: 1002)
        )
        let tc2 = Self.makeToolCall(
            index: 2, toolName: "run_command", isComplete: true,
            startedAt: Date(timeIntervalSince1970: 1001),
            completedAt: Date(timeIntervalSince1970: 1005)
        )
        let tc3 = Self.makeToolCall(
            index: 3, toolName: "edit_file", isComplete: true,
            startedAt: Date(timeIntervalSince1970: 1003),
            completedAt: Date(timeIntervalSince1970: 1004)
        )
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc1, tc2, tc3],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(model.phase == ProgressCardPhase.complete)
        #expect(model.totalToolCount == 3)
        #expect(model.completedToolCount == 3)
        #expect(model.allComplete)
        #expect(model.groupId == tc1.id.uuidString)
        #expect(model.lastToolCall?.id == tc3.id)
        // Two unique tool names
        #expect(model.uniqueToolNamesSorted == ["edit_file", "run_command"])
    }

    // MARK: - Timestamps

    @Test
    func timestampsReflectEarliestAndLatest() {
        let early = Date(timeIntervalSince1970: 500)
        let mid = Date(timeIntervalSince1970: 1000)
        let late = Date(timeIntervalSince1970: 2000)

        let tc1 = Self.makeToolCall(
            index: 1, isComplete: true,
            startedAt: mid, completedAt: late
        )
        let tc2 = Self.makeToolCall(
            index: 2, isComplete: true,
            startedAt: early, completedAt: mid
        )
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc1, tc2],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(model.earliestStartedAt == early)
        #expect(model.latestCompletedAt == late)
    }

    @Test
    func timestampsNilWhenNoToolCalls() {
        let model = ProgressCardPresentationModel.build(
            toolCalls: [],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(model.earliestStartedAt == nil)
        #expect(model.latestCompletedAt == nil)
    }

    // MARK: - Skill Execute Label

    @Test
    func skillExecuteLabelDerivedFromLastSkillLoad() {
        let skillLoad = Self.makeToolCall(
            index: 1, toolName: "skill_load", isComplete: true,
            completedAt: Date(timeIntervalSince1970: 1001),
            inputRawDict: ["skill": AnyCodable("frontend-design")]
        )
        let skillExec = Self.makeToolCall(index: 2, toolName: "skill_execute")
        let model = ProgressCardPresentationModel.build(
            toolCalls: [skillLoad, skillExec],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(model.skillExecuteLabel == "Using my frontend design skill")
    }

    @Test
    func skillExecuteLabelDefaultsWhenNoSkillLoad() {
        let tc = Self.makeToolCall(index: 1, toolName: "skill_execute")
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(model.skillExecuteLabel == "Using a skill")
    }

    // MARK: - Pending Confirmation

    @Test
    func pendingConfirmationDetected() {
        let confirmation = Self.makeConfirmation(state: .pending)
        let tc = Self.makeToolCall(index: 1, pendingConfirmation: confirmation)
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(model.hasPendingConfirmation)
    }

    @Test
    func noPendingConfirmationWhenAbsent() {
        let tc = Self.makeToolCall(index: 1)
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(!model.hasPendingConfirmation)
    }

    // MARK: - isActive

    @Test
    func isActiveForActivePhases() {
        let activePhases: [(String, ProgressCardPresentationModel)] = [
            ("toolRunning", ProgressCardPresentationModel.build(
                toolCalls: [Self.makeToolCall(index: 1)],
                decidedConfirmations: [],
                context: Self.idleContext
            )),
            ("processing", ProgressCardPresentationModel.build(
                toolCalls: [],
                decidedConfirmations: [],
                context: Self.streamingContext(isProcessing: true)
            )),
            ("thinking", ProgressCardPresentationModel.build(
                toolCalls: [],
                decidedConfirmations: [],
                context: Self.idleContext
            )),
        ]
        for (label, model) in activePhases {
            #expect(model.isActive, "Expected isActive for \(label)")
        }
    }

    @Test
    func isNotActiveForTerminalPhases() {
        let complete = ProgressCardPresentationModel.build(
            toolCalls: [Self.makeToolCall(index: 1, isComplete: true, completedAt: Date(timeIntervalSince1970: 1001))],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(!complete.isActive)

        let denied = ProgressCardPresentationModel.build(
            toolCalls: [Self.makeToolCall(index: 1, confirmationDecision: .denied)],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(!denied.isActive)
    }

    // MARK: - Auto-Expand

    @Test
    func autoExpandWhenCompleteAndFlagEnabled() {
        let tc = Self.makeToolCall(
            index: 1, isComplete: true,
            completedAt: Date(timeIntervalSince1970: 1001)
        )
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.idleContext,
            expandCompletedStepsFlag: true
        )
        #expect(model.shouldAutoExpand)
    }

    @Test
    func noAutoExpandWhenCompleteAndFlagDisabled() {
        let tc = Self.makeToolCall(
            index: 1, isComplete: true,
            completedAt: Date(timeIntervalSince1970: 1001)
        )
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.idleContext,
            expandCompletedStepsFlag: false
        )
        #expect(!model.shouldAutoExpand)
    }

    @Test
    func autoExpandWhenDeniedAndFlagEnabled() {
        let tc = Self.makeToolCall(index: 1, confirmationDecision: .denied)
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.idleContext,
            expandCompletedStepsFlag: true
        )
        #expect(model.shouldAutoExpand)
    }

    @Test
    func autoExpandWhenPendingConfirmation() {
        let confirmation = Self.makeConfirmation(state: .pending)
        let tc = Self.makeToolCall(index: 1, pendingConfirmation: confirmation)
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.idleContext,
            expandCompletedStepsFlag: false
        )
        // Pending confirmation always forces auto-expand regardless of flag
        #expect(model.shouldAutoExpand)
    }

    @Test
    func noAutoExpandWhenRunningAndFlagEnabled() {
        let tc = Self.makeToolCall(index: 1)
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.idleContext,
            expandCompletedStepsFlag: true
        )
        // toolRunning phase is not complete/denied, so no auto-expand
        #expect(!model.shouldAutoExpand)
    }

    @Test
    func autoExpandWhenProcessingPhaseAndFlagEnabled() {
        // allComplete=true + isProcessing=true resolves to .processing phase, but
        // auto-expand should still fire because tools are all complete.
        let tc = Self.makeToolCall(
            index: 1, isComplete: true,
            completedAt: Date(timeIntervalSince1970: 1001)
        )
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.streamingContext(isProcessing: true),
            expandCompletedStepsFlag: true
        )
        #expect(model.phase == .processing)
        #expect(model.shouldAutoExpand)
    }

    @Test
    func autoExpandWhenToolsCompleteThinkingPhaseAndFlagEnabled() {
        // allComplete=true + isStreaming=true + hasText=false resolves to
        // .toolsCompleteThinking phase, but auto-expand should still fire.
        let tc = Self.makeToolCall(
            index: 1, isComplete: true,
            completedAt: Date(timeIntervalSince1970: 1001)
        )
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.streamingContext(isStreaming: true, hasText: false),
            expandCompletedStepsFlag: true
        )
        #expect(model.phase == .toolsCompleteThinking)
        #expect(model.shouldAutoExpand)
    }

    // MARK: - Stripped Tool Calls

    @Test
    func hasStrippedToolCallsDetectsStrippedContent() {
        // A completed tool call with all detail fields cleared simulates
        // the state after stripHeavyContent has been applied.
        var stripped = ToolCallData(
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!,
            toolName: "edit_file",
            inputSummary: "",
            inputFull: "",
            isComplete: true,
            startedAt: Date(timeIntervalSince1970: 1000),
            completedAt: Date(timeIntervalSince1970: 1001)
        )
        stripped.inputRawDict = nil
        let model = ProgressCardPresentationModel.build(
            toolCalls: [stripped],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(model.hasStrippedToolCalls)
    }

    @Test
    func hasStrippedToolCallsFalseForNormalToolCall() {
        // A normal complete tool call with populated inputFull should not
        // be detected as stripped.
        let normal = Self.makeToolCall(
            index: 1, isComplete: true,
            completedAt: Date(timeIntervalSince1970: 1001)
        )
        let model = ProgressCardPresentationModel.build(
            toolCalls: [normal],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(!model.hasStrippedToolCalls)
    }

    @Test
    func hasStrippedToolCallsFalseForIncompleteToolCall() {
        // An incomplete tool call with empty fields should not be detected
        // as stripped — only completed tool calls qualify.
        let incomplete = ToolCallData(
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!,
            toolName: "edit_file",
            inputSummary: "",
            inputFull: "",
            isComplete: false,
            startedAt: Date(timeIntervalSince1970: 1000)
        )
        let model = ProgressCardPresentationModel.build(
            toolCalls: [incomplete],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(!model.hasStrippedToolCalls)
    }

    // MARK: - Equatable

    @Test
    func identicalBuildsAreEqual() {
        let tc = Self.makeToolCall(index: 1, isComplete: true, completedAt: Date(timeIntervalSince1970: 1001))
        let a = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        let b = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: Self.idleContext
        )
        #expect(a == b)
    }
}

// MARK: - ProgressCardUIState Tests

@Suite("ProgressCardUIState")
struct ProgressCardUIStateTests {

    private static let id1 = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
    private static let id2 = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
    private static let id3 = UUID(uuidString: "00000000-0000-0000-0000-000000000003")!

    // MARK: - Step Expansion

    @Test
    func stepExpansionToggle() {
        var state = ProgressCardUIState()
        #expect(!state.isStepExpanded(Self.id1))

        state.toggleStepExpansion(Self.id1)
        #expect(state.isStepExpanded(Self.id1))

        state.toggleStepExpansion(Self.id1)
        #expect(!state.isStepExpanded(Self.id1))
    }

    @Test
    func setStepExpandedExplicitly() {
        var state = ProgressCardUIState()
        state.setStepExpanded(Self.id1, expanded: true)
        #expect(state.isStepExpanded(Self.id1))

        state.setStepExpanded(Self.id1, expanded: false)
        #expect(!state.isStepExpanded(Self.id1))
    }

    @Test
    func multipleStepsIndependent() {
        var state = ProgressCardUIState()
        state.setStepExpanded(Self.id1, expanded: true)
        state.setStepExpanded(Self.id2, expanded: true)
        #expect(state.isStepExpanded(Self.id1))
        #expect(state.isStepExpanded(Self.id2))
        #expect(!state.isStepExpanded(Self.id3))
    }

    // MARK: - Card Expansion Overrides

    @Test
    func cardExpansionOverrideReadWrite() {
        var state = ProgressCardUIState()
        #expect(state.cardExpansionOverride(for: Self.id1) == nil)

        state.setCardExpansionOverride(cardKey: Self.id1, expanded: true)
        #expect(state.cardExpansionOverride(for: Self.id1) == true)

        state.setCardExpansionOverride(cardKey: Self.id1, expanded: false)
        #expect(state.cardExpansionOverride(for: Self.id1) == false)
    }

    @Test
    func resolveCardExpandedUsesOverrideWhenPresent() {
        var state = ProgressCardUIState()
        state.setCardExpansionOverride(cardKey: Self.id1, expanded: false)

        // Build a model that would auto-expand
        let tc = ToolCallData(
            id: Self.id1,
            toolName: "edit_file",
            inputSummary: "test",
            isComplete: true,
            startedAt: Date(timeIntervalSince1970: 1000),
            completedAt: Date(timeIntervalSince1970: 1001)
        )
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: .idle,
            expandCompletedStepsFlag: true
        )
        #expect(model.shouldAutoExpand) // Model recommends expansion
        #expect(!state.resolveCardExpanded(cardKey: Self.id1, model: model)) // Override wins
    }

    @Test
    func resolveCardExpandedFallsBackToModelWhenNoOverride() {
        let state = ProgressCardUIState()

        let tc = ToolCallData(
            id: Self.id1,
            toolName: "edit_file",
            inputSummary: "test",
            isComplete: true,
            startedAt: Date(timeIntervalSince1970: 1000),
            completedAt: Date(timeIntervalSince1970: 1001)
        )
        let model = ProgressCardPresentationModel.build(
            toolCalls: [tc],
            decidedConfirmations: [],
            context: .idle,
            expandCompletedStepsFlag: true
        )
        #expect(state.resolveCardExpanded(cardKey: Self.id1, model: model))
    }

    // MARK: - Rehydration Tracking

    @Test
    func rehydrationTracking() {
        var state = ProgressCardUIState()
        #expect(!state.hasRehydrated(groupId: Self.id1))

        state.markRehydrated(groupId: Self.id1)
        #expect(state.hasRehydrated(groupId: Self.id1))
        #expect(!state.hasRehydrated(groupId: Self.id2))
    }

    // MARK: - Reset

    @Test
    func resetClearsAllState() {
        var state = ProgressCardUIState()
        state.setStepExpanded(Self.id1, expanded: true)
        state.setCardExpansionOverride(cardKey: Self.id2, expanded: true)
        state.markRehydrated(groupId: Self.id3)

        state.reset()

        #expect(!state.isStepExpanded(Self.id1))
        #expect(state.cardExpansionOverride(for: Self.id2) == nil)
        #expect(!state.hasRehydrated(groupId: Self.id3))
        #expect(state.expandedStepIds.isEmpty)
        #expect(state.cardExpansionOverrides.isEmpty)
        #expect(state.rehydratedGroupIds.isEmpty)
    }

    // MARK: - Equatable

    @Test
    func equatable() {
        var a = ProgressCardUIState()
        var b = ProgressCardUIState()
        #expect(a == b)

        a.setStepExpanded(Self.id1, expanded: true)
        #expect(a != b)

        b.setStepExpanded(Self.id1, expanded: true)
        #expect(a == b)
    }

    // MARK: - Sendable

    @Test
    func sendableConformance() {
        // Verify the type can cross actor boundaries (compile-time check).
        let state = ProgressCardUIState()
        let _: any Sendable = state
        // If this compiles, Sendable conformance is valid.
        #expect(Bool(true))
    }
}
