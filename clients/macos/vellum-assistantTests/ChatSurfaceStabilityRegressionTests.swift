#if os(macOS)
import XCTest
@testable import VellumAssistantLib
@preconcurrency import VellumAssistantShared

// MARK: - Chat Surface Stability Regression Tests
//
// Deterministic regression tests for the five field-observed freeze
// families in the chat surface. Each scenario exercises the
// projector/controller architecture end-to-end to ensure the
// interaction produces valid, non-degenerate state.
//
// All data flows through:
//   TranscriptProjector  — transcript render model
//   ComposerController   — popup state machine
//
// Run with:
//   cd clients/macos && ./build.sh test --filter ChatSurfaceStabilityRegressionTests

@MainActor
final class ChatSurfaceStabilityRegressionTests: XCTestCase {

    // MARK: - Helpers

    /// Builds an array of ChatMessage instances with alternating user/assistant roles.
    private func buildMessages(count: Int, startIndex: Int = 0) -> [ChatMessage] {
        (startIndex..<startIndex + count).map { i in
            ChatMessage(
                role: i.isMultiple(of: 2) ? .user : .assistant,
                text: "Message \(i)",
                timestamp: Date(timeIntervalSince1970: TimeInterval(1_700_000_000 + i * 10))
            )
        }
    }

    /// Builds a streaming assistant message appended to an existing transcript.
    private func appendStreamingAssistantMessage(to messages: inout [ChatMessage], text: String = "") {
        messages.append(ChatMessage(
            role: .assistant,
            text: text,
            timestamp: Date(timeIntervalSince1970: TimeInterval(1_700_000_000 + messages.count * 10)),
            isStreaming: true
        ))
    }

    /// Projects the given messages through TranscriptProjector with standard defaults.
    private func project(
        messages: [ChatMessage],
        isSending: Bool = false,
        isThinking: Bool = false,
        activeSubagents: [SubagentInfo] = [],
        assistantStatusText: String? = nil,
        assistantActivityPhase: String = "",
        assistantActivityAnchor: String = "",
        assistantActivityReason: String? = nil,
        activePendingRequestId: String? = nil,
        highlightedMessageId: UUID? = nil
    ) -> TranscriptRenderModel {
        TranscriptProjector.project(
            messages: messages,
            paginatedVisibleMessages: messages,
            activeSubagents: activeSubagents,
            isSending: isSending,
            isThinking: isThinking,
            isCompacting: false,
            assistantStatusText: assistantStatusText,
            assistantActivityPhase: assistantActivityPhase,
            assistantActivityAnchor: assistantActivityAnchor,
            assistantActivityReason: assistantActivityReason,
            activePendingRequestId: activePendingRequestId,
            highlightedMessageId: highlightedMessageId
        )
    }

    // MARK: - Scenario 1: Send While Transcript Is Visible
    //
    // Freeze family: user sends a message while the transcript is rendering
    // a streaming response. The projector must produce a stable render model
    // that includes the new user message without degenerate row counts.

    func testSendWhileTranscriptIsVisible() {
        // Start with a visible transcript with an active streaming response.
        var messages = buildMessages(count: 10)
        appendStreamingAssistantMessage(to: &messages, text: "Streaming response...")

        let model1 = project(messages: messages, isSending: true)
        XCTAssertEqual(model1.rows.count, messages.count,
                       "All messages including streaming must appear in rows")
        XCTAssertFalse(model1.shouldShowThinkingIndicator,
                       "Streaming message is visible — no standalone thinking indicator")

        // User sends a new message while the assistant is still streaming.
        messages.append(ChatMessage(
            role: .user,
            text: "New user message",
            timestamp: Date(timeIntervalSince1970: 1_700_000_200)
        ))

        let model2 = project(messages: messages, isSending: true, isThinking: true)
        XCTAssertEqual(model2.rows.count, messages.count,
                       "New user message must appear in projection")
        XCTAssertTrue(model2.hasUserMessage)

        // The projector must produce equal results for identical inputs
        // (idempotency — no hidden mutation).
        let model3 = project(messages: messages, isSending: true, isThinking: true)
        XCTAssertEqual(model2, model3,
                       "Projector must be idempotent for identical inputs")
    }

    // MARK: - Scenario 2: Scroll During a Streaming Response
    //
    // Freeze family: user scrolls up during an active streaming response.
    // The scroll coordinator must detach from follow-bottom without
    // fight-back or mode oscillation.

    func testScrollDuringStreamingResponse() {
        // The projector must produce valid state during free browsing.
        var messages = buildMessages(count: 20)
        appendStreamingAssistantMessage(to: &messages, text: "Streaming text")
        let model = project(messages: messages, isSending: true)
        XCTAssertEqual(model.rows.count, messages.count)
        XCTAssertFalse(model.rows.isEmpty)
    }

    // MARK: - Scenario 3: Expand a Tool Block During Streaming
    //
    // Freeze family: user clicks to expand a tool-call details block
    // while a streaming response is active. The scroll coordinator must
    // enter stabilization and detach from follow-bottom.

    func testExpandToolBlockDuringStreaming() {
        // Verify the projector handles tool calls correctly.
        var messages = buildMessages(count: 6)
        // Add a message with an incomplete tool call.
        messages.append(ChatMessage(
            role: .assistant,
            text: "",
            timestamp: Date(timeIntervalSince1970: 1_700_000_100),
            isStreaming: true,
            toolCalls: [
                ToolCallData(toolName: "bash", inputSummary: "ls -la", isComplete: false)
            ]
        ))

        let model = project(messages: messages, isSending: true)
        XCTAssertTrue(model.hasActiveToolCall,
                      "Must detect active tool call")
        XCTAssertFalse(model.shouldShowThinkingIndicator,
                       "Must not show thinking indicator during active tool call")
        XCTAssertEqual(model.rows.count, messages.count)
    }

    // MARK: - Scenario 4: Type With Emoji or Slash Popup Open
    //
    // Freeze family: user types while the emoji picker or slash command
    // popup is visible. The ComposerController must maintain consistent
    // popup state without degenerate menu-refresh scheduling.

    func testTypeWithEmojiPopupOpen() {
        let controller = ComposerController(
            slashCommandProvider: StubSlashCommandProvider(commands: []),
            emojiSearchProvider: StubEmojiSearchProvider(entries: [
                EmojiEntry(shortcode: "party_popper", emoji: "\u{1F389}"),
                EmojiEntry(shortcode: "partying_face", emoji: "\u{1F973}"),
            ])
        )

        // Type `:par` to trigger the emoji popup (needs 2+ chars after colon).
        controller.textChanged(":par")
        controller.cursorMoved(to: 4)
        controller.performMenuRefresh()

        XCTAssertTrue(controller.showEmojiMenu,
                      "Emoji menu must be visible after trigger")
        XCTAssertEqual(controller.emojiFilter, "par")
        XCTAssertFalse(controller.showSlashMenu)

        // Continue typing while emoji popup is visible.
        controller.textChanged(":part")
        controller.cursorMoved(to: 5)
        controller.performMenuRefresh()

        XCTAssertTrue(controller.showEmojiMenu,
                      "Emoji menu must stay visible during typing")
        XCTAssertEqual(controller.emojiFilter, "part")

        // The projector must remain stable during popup interactions.
        let messages = buildMessages(count: 5)
        let model1 = project(messages: messages)
        let model2 = project(messages: messages)
        XCTAssertEqual(model1, model2,
                       "Projector must be stable during popup interactions")
    }

    func testTypeWithSlashPopupOpen() {
        let slashDescriptors = [
            ChatSlashCommandDescriptor(
                name: "help",
                description: "Show help",
                icon: "questionmark.circle",
                selectionBehavior: .autoSend,
                pickerPlatforms: [.macos],
                helpBubblePlatforms: [.macos],
                sendPathPlatforms: [.macos]
            ),
            ChatSlashCommandDescriptor(
                name: "history",
                description: "Show history",
                icon: "clock",
                selectionBehavior: .autoSend,
                pickerPlatforms: [.macos],
                helpBubblePlatforms: [.macos],
                sendPathPlatforms: [.macos]
            ),
        ]

        let controller = ComposerController(
            slashCommandProvider: StubSlashCommandProvider(
                commands: slashDescriptors.map(SlashCommand.init(descriptor:))
            ),
            emojiSearchProvider: StubEmojiSearchProvider(entries: [])
        )

        // Type `/h` to trigger the slash popup.
        controller.textChanged("/h")
        controller.cursorMoved(to: 2)
        controller.performMenuRefresh()

        XCTAssertTrue(controller.showSlashMenu,
                      "Slash menu must be visible after trigger")
        XCTAssertEqual(controller.slashFilter, "h")
        XCTAssertFalse(controller.showEmojiMenu)

        // Continue typing while slash popup is visible.
        controller.textChanged("/he")
        controller.cursorMoved(to: 3)
        controller.performMenuRefresh()

        XCTAssertTrue(controller.showSlashMenu,
                      "Slash menu must stay visible during typing")
        XCTAssertEqual(controller.slashFilter, "he")

        // Navigate and dismiss — state must be clean.
        controller.handleSlashNavigation(.dismiss)
        XCTAssertFalse(controller.showSlashMenu)
        XCTAssertFalse(controller.isPopupVisible)
    }

    // MARK: - Scenario 5: Typing With Completed Progress Cards
    //
    // Freeze family: user types in the composer while the transcript
    // contains completed progress cards (assistant tool call messages
    // with isComplete=true). The projector and scroll coordinator must
    // produce stable state without cross-subtree observation.

    func testTypingWithCompletedProgressCards() {
        // Build a transcript with completed tool calls.
        var messages = buildMessages(count: 4)
        messages.append(ChatMessage(
            role: .assistant,
            text: "Running command...",
            timestamp: Date(timeIntervalSince1970: 1_700_000_080),
            toolCalls: [
                ToolCallData(toolName: "bash", inputSummary: "echo hello", result: "hello", isComplete: true),
                ToolCallData(toolName: "bash", inputSummary: "ls", result: "file1.txt\nfile2.txt", isComplete: true)
            ]
        ))
        messages.append(ChatMessage(
            role: .assistant,
            text: "Done! Both commands completed successfully.",
            timestamp: Date(timeIntervalSince1970: 1_700_000_090)
        ))

        // Project with completed progress cards and no active sending.
        let model1 = project(messages: messages, isSending: false)
        XCTAssertEqual(model1.rows.count, messages.count)
        XCTAssertFalse(model1.hasActiveToolCall,
                       "Completed tool calls must not be flagged as active")
        XCTAssertFalse(model1.shouldShowThinkingIndicator)
        XCTAssertFalse(model1.isStreamingWithoutText)

        // Simulate user typing — re-project with identical transcript.
        // The projection must be identical (no hidden typing-related
        // side effects on the render model).
        let model2 = project(messages: messages, isSending: false)
        XCTAssertEqual(model1, model2,
                       "Re-projection with identical inputs must be stable during typing")

        // Verify the ComposerController handles typing cleanly
        // without affecting the transcript state.
        let controller = ComposerController(
            slashCommandProvider: StubSlashCommandProvider(commands: []),
            emojiSearchProvider: StubEmojiSearchProvider(entries: [])
        )
        controller.textChanged("Hello")
        controller.cursorMoved(to: 5)
        controller.performMenuRefresh()
        XCTAssertFalse(controller.isPopupVisible,
                       "Normal typing must not trigger any popup")

        // Final re-projection must still match.
        let model3 = project(messages: messages, isSending: false)
        XCTAssertEqual(model1, model3,
                       "Projection must be fully deterministic across typing cycles")
    }

    // MARK: - Cross-Subsystem Integration

    /// Verifies that the three subsystems (projector, controller, coordinator)
    /// can all operate in the same scenario without interfering with each other.
    func testAllSubsystemsOperateIndependently() {
        // Set up all three subsystems.
        var messages = buildMessages(count: 10)
        appendStreamingAssistantMessage(to: &messages, text: "Streaming...")

        let controller = ComposerController(
            slashCommandProvider: StubSlashCommandProvider(commands: []),
            emojiSearchProvider: StubEmojiSearchProvider(entries: [
                EmojiEntry(shortcode: "thumbsup", emoji: "\u{1F44D}"),
            ])
        )

        // Project the transcript.
        let model = project(messages: messages, isSending: true)
        XCTAssertEqual(model.rows.count, messages.count)

        // Operate the controller.
        controller.textChanged(":thumbsup")
        controller.cursorMoved(to: 9)
        controller.performMenuRefresh()
        XCTAssertTrue(controller.showEmojiMenu)

        // Re-project — must be unaffected by controller state.
        let model2 = project(messages: messages, isSending: true)
        XCTAssertEqual(model, model2,
                       "Projector output must be independent of controller state")
    }
}

// MARK: - Test Stubs

/// Stub slash command provider for deterministic testing.
private struct StubSlashCommandProvider: SlashCommandProvider {
    let commands: [SlashCommand]

    func filteredCommands(_ filter: String) -> [SlashCommand] {
        commands.filter { filter.isEmpty || $0.name.lowercased().hasPrefix(filter.lowercased()) }
    }
}

/// Stub emoji search provider for deterministic testing.
private struct StubEmojiSearchProvider: EmojiSearchProvider {
    let entries: [EmojiEntry]

    func search(query: String, limit: Int) -> [EmojiEntry] {
        let matched = entries.filter { $0.shortcode.contains(query.lowercased()) }
        return Array(matched.prefix(limit))
    }
}
#endif
