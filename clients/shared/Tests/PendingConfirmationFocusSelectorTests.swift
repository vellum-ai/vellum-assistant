import Testing
@testable import VellumAssistantShared

@Suite("PendingConfirmationFocusSelector")
struct PendingConfirmationFocusSelectorTests {

    // MARK: - Helpers

    private func makeConfirmationMessage(requestId: String, state: ToolConfirmationState) -> ChatMessage {
        ChatMessage(
            role: .assistant,
            text: "",
            confirmation: ToolConfirmationData(
                requestId: requestId,
                toolName: "host_bash",
                input: [:],
                riskLevel: "medium",
                state: state
            )
        )
    }

    // MARK: - Tests

    @Test("Returns nil when no messages")
    func emptyMessages() {
        let result = PendingConfirmationFocusSelector.activeRequestId(from: [])
        #expect(result == nil)
    }

    @Test("Returns nil when no pending confirmations exist")
    func noPendingConfirmations() {
        let messages = [
            ChatMessage(role: .user, text: "Hello"),
            makeConfirmationMessage(requestId: "req-1", state: .approved),
            makeConfirmationMessage(requestId: "req-2", state: .denied),
            ChatMessage(role: .assistant, text: "Done"),
        ]
        let result = PendingConfirmationFocusSelector.activeRequestId(from: messages)
        #expect(result == nil)
    }

    @Test("Returns first pending confirmation requestId when one exists")
    func singlePendingConfirmation() {
        let messages = [
            ChatMessage(role: .assistant, text: "Working..."),
            makeConfirmationMessage(requestId: "req-42", state: .pending),
        ]
        let result = PendingConfirmationFocusSelector.activeRequestId(from: messages)
        #expect(result == "req-42")
    }

    @Test("Returns the first pending requestId when multiple pending confirmations exist")
    func multiplePendingConfirmations() {
        let messages = [
            makeConfirmationMessage(requestId: "req-1", state: .pending),
            makeConfirmationMessage(requestId: "req-2", state: .pending),
            makeConfirmationMessage(requestId: "req-3", state: .pending),
        ]
        let result = PendingConfirmationFocusSelector.activeRequestId(from: messages)
        #expect(result == "req-1")
    }

    @Test("Ignores non-pending confirmations and returns first pending")
    func ignoresNonPending() {
        let messages = [
            makeConfirmationMessage(requestId: "req-1", state: .approved),
            makeConfirmationMessage(requestId: "req-2", state: .denied),
            makeConfirmationMessage(requestId: "req-3", state: .timedOut),
            makeConfirmationMessage(requestId: "req-4", state: .pending),
        ]
        let result = PendingConfirmationFocusSelector.activeRequestId(from: messages)
        #expect(result == "req-4")
    }
}
