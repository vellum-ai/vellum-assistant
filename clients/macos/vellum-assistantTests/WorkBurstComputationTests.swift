import Foundation
import Testing
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Tests for `ChatBubble.computeWorkBursts(...)` — verifies that consecutive
/// tool-call and thinking groups are merged into work bursts, while text and
/// surface groups create burst boundaries.
@Suite("WorkBurst Computation")
struct WorkBurstComputationTests {

    // MARK: - Helpers

    private static let messageId = UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!

    /// Creates a minimal ToolCallData with a deterministic UUID.
    private static func makeToolCall(index: Int) -> ToolCallData {
        let id = UUID(uuidString: "00000000-0000-0000-0000-\(String(format: "%012d", index))")!
        var tc = ToolCallData(
            id: id,
            toolName: "tool_\(index)",
            inputSummary: "input \(index)"
        )
        tc.isComplete = true
        tc.startedAt = Date(timeIntervalSince1970: 1000 + Double(index))
        tc.completedAt = Date(timeIntervalSince1970: 1001 + Double(index))
        return tc
    }

    private typealias ContentGroup = ChatBubble.ContentGroup

    // MARK: - Single tool group -> one burst

    @Test("Single tool group produces one burst")
    func singleToolGroup() {
        let groups: [ContentGroup] = [
            .toolCalls([0, 1])
        ]
        let contentOrder: [ContentBlockRef] = [
            .toolCall(0), .toolCall(1)
        ]
        let toolCalls = [Self.makeToolCall(index: 0), Self.makeToolCall(index: 1)]

        let bursts = ChatBubble.computeWorkBursts(
            groups: groups,
            contentOrder: contentOrder,
            toolCalls: toolCalls,
            thinkingSegments: [],
            showThinking: false,
            isStreaming: false,
            messageId: Self.messageId
        )

        #expect(bursts.count == 1)
        #expect(bursts[0].toolIndices == [0, 1])
        #expect(bursts[0].thinkingIndices.isEmpty)
        #expect(bursts[0].stableId == "tc0")
        #expect(bursts[0].expandedItems.count == 2)
    }

    // MARK: - tool-text-tool -> two bursts

    @Test("Tool-text-tool produces two bursts")
    func toolTextTool() {
        let groups: [ContentGroup] = [
            .toolCalls([0]),
            .texts([0]),
            .toolCalls([1])
        ]
        let contentOrder: [ContentBlockRef] = [
            .toolCall(0), .text(0), .toolCall(1)
        ]
        let toolCalls = [Self.makeToolCall(index: 0), Self.makeToolCall(index: 1)]

        let bursts = ChatBubble.computeWorkBursts(
            groups: groups,
            contentOrder: contentOrder,
            toolCalls: toolCalls,
            thinkingSegments: [],
            showThinking: false,
            isStreaming: false,
            messageId: Self.messageId
        )

        #expect(bursts.count == 2)
        #expect(bursts[0].toolIndices == [0])
        #expect(bursts[0].stableId == "tc0")
        #expect(bursts[1].toolIndices == [1])
        #expect(bursts[1].stableId == "tc1")
    }

    // MARK: - thinking-tool-text-thinking-tool -> two bursts, thinking folded correctly

    @Test("Thinking-tool-text-thinking-tool produces two bursts with thinking folded")
    func thinkingToolTextThinkingTool() {
        let groups: [ContentGroup] = [
            .thinking([0]),
            .toolCalls([0]),
            .texts([0]),
            .thinking([1]),
            .toolCalls([1])
        ]
        let contentOrder: [ContentBlockRef] = [
            .thinking(0), .toolCall(0), .text(0), .thinking(1), .toolCall(1)
        ]
        let toolCalls = [Self.makeToolCall(index: 0), Self.makeToolCall(index: 1)]
        let thinkingSegments = ["Thinking about first task...", "Thinking about second task..."]

        let bursts = ChatBubble.computeWorkBursts(
            groups: groups,
            contentOrder: contentOrder,
            toolCalls: toolCalls,
            thinkingSegments: thinkingSegments,
            showThinking: true,
            isStreaming: false,
            messageId: Self.messageId
        )

        #expect(bursts.count == 2)

        // First burst: thinking[0] + tool[0]
        #expect(bursts[0].toolIndices == [0])
        #expect(bursts[0].thinkingIndices == [0])
        #expect(bursts[0].stableId == "th0")
        #expect(bursts[0].expandedItems.count == 2)
        // Verify order: thinking first, then tool call
        if case .thinking(let content, _, _) = bursts[0].expandedItems[0] {
            #expect(content == "Thinking about first task...")
        } else {
            Issue.record("Expected thinking item at index 0")
        }
        if case .toolCall(let tc) = bursts[0].expandedItems[1] {
            #expect(tc.toolName == "tool_0")
        } else {
            Issue.record("Expected tool call item at index 1")
        }

        // Second burst: thinking[1] + tool[1]
        #expect(bursts[1].toolIndices == [1])
        #expect(bursts[1].thinkingIndices == [1])
        #expect(bursts[1].stableId == "th1")
    }

    // MARK: - Standalone thinking separated by text is forwarded into the following tool burst

    @Test("Standalone thinking separated by text is forwarded into the following tool burst")
    func standaloneThinking() {
        let groups: [ContentGroup] = [
            .thinking([0]),
            .texts([0]),
            .toolCalls([0])
        ]
        let contentOrder: [ContentBlockRef] = [
            .thinking(0), .text(0), .toolCall(0)
        ]
        let toolCalls = [Self.makeToolCall(index: 0)]
        let thinkingSegments = ["Standalone thought"]

        let bursts = ChatBubble.computeWorkBursts(
            groups: groups,
            contentOrder: contentOrder,
            toolCalls: toolCalls,
            thinkingSegments: thinkingSegments,
            showThinking: true,
            isStreaming: false,
            messageId: Self.messageId
        )

        // Only one burst — thinking is forwarded into the tool burst for decluttering.
        #expect(bursts.count == 1)
        #expect(bursts[0].toolIndices == [0])
        #expect(bursts[0].thinkingIndices == [0])
        #expect(bursts[0].stableId == "th0")
    }

    // MARK: - thinking-tool-tool-thinking-tool-text -> one burst with all items

    @Test("Thinking-tool-tool-thinking-tool-text produces one burst with all items")
    func thinkingToolToolThinkingToolText() {
        let groups: [ContentGroup] = [
            .thinking([0]),
            .toolCalls([0, 1]),
            .thinking([1]),
            .toolCalls([2]),
            .texts([0])
        ]
        let contentOrder: [ContentBlockRef] = [
            .thinking(0), .toolCall(0), .toolCall(1), .thinking(1), .toolCall(2), .text(0)
        ]
        let toolCalls = [
            Self.makeToolCall(index: 0),
            Self.makeToolCall(index: 1),
            Self.makeToolCall(index: 2)
        ]
        let thinkingSegments = ["First thought", "Second thought"]

        let bursts = ChatBubble.computeWorkBursts(
            groups: groups,
            contentOrder: contentOrder,
            toolCalls: toolCalls,
            thinkingSegments: thinkingSegments,
            showThinking: true,
            isStreaming: false,
            messageId: Self.messageId
        )

        #expect(bursts.count == 1)
        #expect(bursts[0].toolIndices == [0, 1, 2])
        #expect(bursts[0].thinkingIndices == [0, 1])
        #expect(bursts[0].stableId == "th0")

        // Verify expandedItems order matches contentOrder
        #expect(bursts[0].expandedItems.count == 5)
        if case .thinking(let content, _, _) = bursts[0].expandedItems[0] {
            #expect(content == "First thought")
        } else {
            Issue.record("Expected thinking at index 0")
        }
        if case .toolCall(let tc) = bursts[0].expandedItems[1] {
            #expect(tc.toolName == "tool_0")
        } else {
            Issue.record("Expected tool_0 at index 1")
        }
        if case .toolCall(let tc) = bursts[0].expandedItems[2] {
            #expect(tc.toolName == "tool_1")
        } else {
            Issue.record("Expected tool_1 at index 2")
        }
        if case .thinking(let content, _, _) = bursts[0].expandedItems[3] {
            #expect(content == "Second thought")
        } else {
            Issue.record("Expected thinking at index 3")
        }
        if case .toolCall(let tc) = bursts[0].expandedItems[4] {
            #expect(tc.toolName == "tool_2")
        } else {
            Issue.record("Expected tool_2 at index 4")
        }
    }

    // MARK: - Empty content order -> no bursts

    @Test("Empty content order produces no bursts")
    func emptyContentOrder() {
        let bursts = ChatBubble.computeWorkBursts(
            groups: [],
            contentOrder: [],
            toolCalls: [],
            thinkingSegments: [],
            showThinking: true,
            isStreaming: false,
            messageId: Self.messageId
        )

        #expect(bursts.isEmpty)
    }

    // MARK: - expandedItems order matches contentOrder within each burst

    @Test("Expanded items order matches contentOrder within each burst")
    func expandedItemsOrderMatchesContentOrder() {
        // Content order: think0, tool0, think1, tool1
        // But groups merge consecutive types:
        let groups: [ContentGroup] = [
            .thinking([0]),
            .toolCalls([0]),
            .thinking([1]),
            .toolCalls([1])
        ]
        let contentOrder: [ContentBlockRef] = [
            .thinking(0), .toolCall(0), .thinking(1), .toolCall(1)
        ]
        let toolCalls = [Self.makeToolCall(index: 0), Self.makeToolCall(index: 1)]
        let thinkingSegments = ["Thought A", "Thought B"]

        let bursts = ChatBubble.computeWorkBursts(
            groups: groups,
            contentOrder: contentOrder,
            toolCalls: toolCalls,
            thinkingSegments: thinkingSegments,
            showThinking: true,
            isStreaming: false,
            messageId: Self.messageId
        )

        #expect(bursts.count == 1)
        #expect(bursts[0].expandedItems.count == 4)

        // Verify chronological order: think0, tool0, think1, tool1
        if case .thinking(let content, _, _) = bursts[0].expandedItems[0] {
            #expect(content == "Thought A")
        } else {
            Issue.record("Expected thinking 'Thought A' at index 0")
        }
        if case .toolCall(let tc) = bursts[0].expandedItems[1] {
            #expect(tc.toolName == "tool_0")
        } else {
            Issue.record("Expected tool_0 at index 1")
        }
        if case .thinking(let content, _, _) = bursts[0].expandedItems[2] {
            #expect(content == "Thought B")
        } else {
            Issue.record("Expected thinking 'Thought B' at index 2")
        }
        if case .toolCall(let tc) = bursts[0].expandedItems[3] {
            #expect(tc.toolName == "tool_1")
        } else {
            Issue.record("Expected tool_1 at index 3")
        }
    }

    // MARK: - showThinking flag gates thinking items

    @Test("Thinking items are excluded when showThinking is false")
    func showThinkingFlagGatesThinking() {
        let groups: [ContentGroup] = [
            .thinking([0]),
            .toolCalls([0])
        ]
        let contentOrder: [ContentBlockRef] = [
            .thinking(0), .toolCall(0)
        ]
        let toolCalls = [Self.makeToolCall(index: 0)]
        let thinkingSegments = ["Some thought"]

        let bursts = ChatBubble.computeWorkBursts(
            groups: groups,
            contentOrder: contentOrder,
            toolCalls: toolCalls,
            thinkingSegments: thinkingSegments,
            showThinking: false,
            isStreaming: false,
            messageId: Self.messageId
        )

        #expect(bursts.count == 1)
        // Thinking is in the burst's thinkingIndices (for grouping) but not in expandedItems
        #expect(bursts[0].thinkingIndices == [0])
        #expect(bursts[0].expandedItems.count == 1)
        if case .toolCall = bursts[0].expandedItems[0] {
            // Good — only tool call present
        } else {
            Issue.record("Expected only tool call in expanded items when showThinking is false")
        }
    }

    // MARK: - isStreaming only applies to last burst thinking items

    @Test("isStreaming flag only applies to thinking items in the last burst")
    func streamingOnlyLastBurst() {
        let groups: [ContentGroup] = [
            .thinking([0]),
            .toolCalls([0]),
            .texts([0]),
            .thinking([1]),
            .toolCalls([1])
        ]
        let contentOrder: [ContentBlockRef] = [
            .thinking(0), .toolCall(0), .text(0), .thinking(1), .toolCall(1)
        ]
        let toolCalls = [Self.makeToolCall(index: 0), Self.makeToolCall(index: 1)]
        let thinkingSegments = ["First thought", "Second thought"]

        let bursts = ChatBubble.computeWorkBursts(
            groups: groups,
            contentOrder: contentOrder,
            toolCalls: toolCalls,
            thinkingSegments: thinkingSegments,
            showThinking: true,
            isStreaming: true,
            messageId: Self.messageId
        )

        #expect(bursts.count == 2)

        // First burst's thinking should NOT be streaming
        if case .thinking(_, _, let isStreaming) = bursts[0].expandedItems[0] {
            #expect(!isStreaming)
        } else {
            Issue.record("Expected thinking item in first burst")
        }

        // Second burst's thinking should NOT be streaming — a tool call follows
        if case .thinking(_, _, let isStreaming) = bursts[1].expandedItems[0] {
            #expect(!isStreaming)
        } else {
            Issue.record("Expected thinking item in second burst")
        }
    }

    // MARK: - Empty thinking segments are skipped

    @Test("Empty thinking segments are not included in expanded items")
    func emptyThinkingSegmentsSkipped() {
        let groups: [ContentGroup] = [
            .thinking([0]),
            .toolCalls([0])
        ]
        let contentOrder: [ContentBlockRef] = [
            .thinking(0), .toolCall(0)
        ]
        let toolCalls = [Self.makeToolCall(index: 0)]
        let thinkingSegments = [""]  // Empty segment

        let bursts = ChatBubble.computeWorkBursts(
            groups: groups,
            contentOrder: contentOrder,
            toolCalls: toolCalls,
            thinkingSegments: thinkingSegments,
            showThinking: true,
            isStreaming: false,
            messageId: Self.messageId
        )

        #expect(bursts.count == 1)
        // Only tool call — empty thinking is skipped
        #expect(bursts[0].expandedItems.count == 1)
    }

    // MARK: - Expansion key format

    @Test("Thinking expansion keys use correct format")
    func thinkingExpansionKeyFormat() {
        let groups: [ContentGroup] = [
            .thinking([3]),
            .toolCalls([0])
        ]
        let contentOrder: [ContentBlockRef] = [
            .thinking(3), .toolCall(0)
        ]
        let toolCalls = [Self.makeToolCall(index: 0)]
        let thinkingSegments = ["", "", "", "Third thought"]

        let bursts = ChatBubble.computeWorkBursts(
            groups: groups,
            contentOrder: contentOrder,
            toolCalls: toolCalls,
            thinkingSegments: thinkingSegments,
            showThinking: true,
            isStreaming: false,
            messageId: Self.messageId
        )

        #expect(bursts.count == 1)
        if case .thinking(_, let key, _) = bursts[0].expandedItems[0] {
            #expect(key == "\(Self.messageId.uuidString)-th3")
        } else {
            Issue.record("Expected thinking item with correct expansion key")
        }
    }

    // MARK: - Surface group flushes burst

    @Test("Surface groups flush the current burst like text groups")
    func surfaceFlushBurst() {
        let groups: [ContentGroup] = [
            .toolCalls([0]),
            .surface(0),
            .toolCalls([1])
        ]
        let contentOrder: [ContentBlockRef] = [
            .toolCall(0), .surface(0), .toolCall(1)
        ]
        let toolCalls = [Self.makeToolCall(index: 0), Self.makeToolCall(index: 1)]

        let bursts = ChatBubble.computeWorkBursts(
            groups: groups,
            contentOrder: contentOrder,
            toolCalls: toolCalls,
            thinkingSegments: [],
            showThinking: false,
            isStreaming: false,
            messageId: Self.messageId
        )

        #expect(bursts.count == 2)
        #expect(bursts[0].toolIndices == [0])
        #expect(bursts[1].toolIndices == [1])
    }
}
