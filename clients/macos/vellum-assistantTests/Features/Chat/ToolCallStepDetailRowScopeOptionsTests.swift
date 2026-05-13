import Foundation
import Testing
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Unit tests for `ToolCallStepDetailRow.scopeOptions(from:)`, which feeds the
/// "Apply to" chip ladder in the Rule Editor modal.
///
/// Priority contract (matches the JSDoc in production):
///   1. `riskAllowlistOptions` (Minimatch-glob patterns from classifier — save-correct)
///   2. `riskScopeOptions` (regex display patterns — UI fallback only)
///   3. Synthesized "*" wildcard (natural-language activity strings, unclassified tools)
@Suite("ToolCallStepDetailRow scopeOptions(from:)")
struct ToolCallStepDetailRowScopeOptionsTests {

    // MARK: - Helpers

    private static func makeToolCall(
        toolName: String = "bash",
        inputSummary: String = "echo hello",
        inputRawValue: String = "echo hello",
        reasonDescription: String? = nil,
        riskScopeOptions: [ToolResultRiskScopeOption]? = nil,
        riskAllowlistOptions: [ConfirmationRequestAllowlistOption]? = nil
    ) -> ToolCallData {
        let id = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        var tc = ToolCallData(
            id: id,
            toolName: toolName,
            inputSummary: inputSummary,
            inputRawValue: inputRawValue
        )
        tc.reasonDescription = reasonDescription
        tc.riskScopeOptions = riskScopeOptions
        tc.riskAllowlistOptions = riskAllowlistOptions
        return tc
    }

    // MARK: - Priority 1: riskAllowlistOptions wins

    @Test("riskAllowlistOptions wins over riskScopeOptions when both present")
    @MainActor
    func allowlistOverridesScopeOptions() async {
        let tc = Self.makeToolCall(
            // Display ladder (regex shape — would be wrong for save).
            riskScopeOptions: [
                ToolResultRiskScopeOption(pattern: "^echo\\b.*hello$", label: "echo hello"),
                ToolResultRiskScopeOption(pattern: "^echo\\b", label: "echo *"),
            ],
            // Save ladder (Minimatch-glob shape — what the rule editor must save).
            riskAllowlistOptions: [
                ConfirmationRequestAllowlistOption(
                    label: "echo hello",
                    description: "This exact command",
                    pattern: "echo hello"
                ),
                ConfirmationRequestAllowlistOption(
                    label: "echo *",
                    description: "Any echo command",
                    pattern: "action:echo"
                ),
            ]
        )

        let result = ToolCallStepDetailRow.scopeOptions(from: tc)

        #expect(result.count == 2)
        #expect(result[0].label == "echo hello")
        #expect(result[0].pattern == "echo hello")
        #expect(result[1].label == "echo *")
        #expect(result[1].pattern == "action:echo")
    }

    // MARK: - Priority 2: riskScopeOptions fallback

    @Test("riskScopeOptions used when riskAllowlistOptions is nil")
    @MainActor
    func fallsBackToScopeOptionsWhenAllowlistNil() async {
        let tc = Self.makeToolCall(
            riskScopeOptions: [
                ToolResultRiskScopeOption(pattern: "https://example.com/.*", label: "example.com"),
            ],
            riskAllowlistOptions: nil
        )

        let result = ToolCallStepDetailRow.scopeOptions(from: tc)

        #expect(result.count == 1)
        #expect(result[0].label == "example.com")
        #expect(result[0].pattern == "https://example.com/.*")
    }

    @Test("riskScopeOptions used when riskAllowlistOptions is empty array")
    @MainActor
    func fallsBackToScopeOptionsWhenAllowlistEmpty() async {
        // web-risk-classifier emits empty allowlistOptions: [] explicitly.
        let tc = Self.makeToolCall(
            riskScopeOptions: [
                ToolResultRiskScopeOption(pattern: "https://example.com/.*", label: "example.com"),
            ],
            riskAllowlistOptions: []
        )

        let result = ToolCallStepDetailRow.scopeOptions(from: tc)

        #expect(result.count == 1)
        #expect(result[0].pattern == "https://example.com/.*")
    }

    // MARK: - Priority 3: synthesized wildcard

    @Test("synthesizes wildcard when both option arrays are absent and input is natural-language")
    @MainActor
    func synthesizesWildcardForNaturalLanguageActivity() async {
        // Mirror the case from PR #6033's screenshot: `remember` with no
        // priority key — `inputRawValue` ends up holding the activity string.
        let tc = Self.makeToolCall(
            toolName: "remember",
            inputRawValue: "desktop files count items",
            reasonDescription: "desktop files count items"
        )

        let result = ToolCallStepDetailRow.scopeOptions(from: tc)

        #expect(result.count == 1)
        #expect(result[0].pattern == "*")
        #expect(result[0].label == "Any remember call")
    }

    @Test("synthesizes raw input when no options and input is real command shape")
    @MainActor
    func synthesizesRawInputForRealCommand() async {
        let tc = Self.makeToolCall(
            toolName: "bash",
            inputRawValue: "ls -la /tmp",
            reasonDescription: "Listing tmp directory"
        )

        let result = ToolCallStepDetailRow.scopeOptions(from: tc)

        #expect(result.count == 1)
        #expect(result[0].pattern == "ls -la /tmp")
        #expect(result[0].label == "ls -la /tmp")
    }

    // MARK: - Edge cases

    @Test("empty riskAllowlistOptions falls through to riskScopeOptions, then to synthesis")
    @MainActor
    func emptyAllowlistAndEmptyScopeFallsThroughToSynthesis() async {
        let tc = Self.makeToolCall(
            toolName: "bash",
            inputRawValue: "ls",
            riskScopeOptions: [],
            riskAllowlistOptions: []
        )

        let result = ToolCallStepDetailRow.scopeOptions(from: tc)

        #expect(result.count == 1)
        #expect(result[0].pattern == "ls")
    }

    @Test("riskAllowlistOptions description is not surfaced in ScopeOptionItem (label/pattern only)")
    @MainActor
    func descriptionIsDroppedFromScopeOptionItem() async {
        // The chip ladder UI only renders label + pattern — descriptions are
        // documentation for the LLM suggestion path. Confirms we don't
        // accidentally leak descriptions into the visible chip text.
        let tc = Self.makeToolCall(
            riskAllowlistOptions: [
                ConfirmationRequestAllowlistOption(
                    label: "echo hello",
                    description: "This very specific command exactly",
                    pattern: "echo hello"
                ),
            ]
        )

        let result = ToolCallStepDetailRow.scopeOptions(from: tc)

        #expect(result.count == 1)
        #expect(result[0].label == "echo hello")
        #expect(result[0].pattern == "echo hello")
        // ScopeOptionItem has no description field — verified by absence at type level.
    }
}
