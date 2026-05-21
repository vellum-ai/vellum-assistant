import Foundation
import Testing
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@Suite("HistoryReconstructionService.parseContentOrder")
struct HistoryReconstructionParseContentOrderTests {

    @Test("Parses known prefixes including attachment")
    func parsesAllKnownPrefixes() {
        let refs = HistoryReconstructionService.parseContentOrder([
            "text:0",
            "attachment:0",
            "attachment:1",
            "text:1",
            "tool:0",
            "surface:2",
            "thinking:0",
        ])
        #expect(refs == [
            .text(0),
            .attachment(0),
            .attachment(1),
            .text(1),
            .toolCall(0),
            .surface(2),
            .thinking(0),
        ])
    }

    @Test("Drops unknown prefixes silently")
    func dropsUnknownPrefixes() {
        let refs = HistoryReconstructionService.parseContentOrder([
            "text:0",
            "futureType:5",
            "attachment:0",
        ])
        #expect(refs == [.text(0), .attachment(0)])
    }

    @Test("Drops malformed entries")
    func dropsMalformed() {
        let refs = HistoryReconstructionService.parseContentOrder([
            "attachment:",
            "attachment:notanumber",
            "noColon",
            "attachment:7",
        ])
        #expect(refs == [.attachment(7)])
    }
}

@Suite("ChatBubble.computeContentGroupsStatic with attachments")
struct ChatBubbleComputeContentGroupsAttachmentTests {

    private typealias ContentGroup = ChatBubble.ContentGroup

    @Test("Attachment entries become their own group between text runs")
    func attachmentInterleavedWithText() {
        let groups = ChatBubble.computeContentGroupsStatic(
            contentOrder: [
                .text(0),
                .attachment(0),
                .attachment(1),
                .text(1),
            ],
            hasInterleavedContent: true
        )
        #expect(groups == [
            .texts([0]),
            .attachment(0),
            .attachment(1),
            .texts([1]),
        ])
    }

    @Test("Attachment breaks text-run coalescing")
    func attachmentBreaksCoalescing() {
        // With no tool calls, the post-process coalescing kicks in. Attachments
        // must act like surfaces and prevent the two text groups from merging.
        let groups = ChatBubble.computeContentGroupsStatic(
            contentOrder: [
                .text(0),
                .attachment(0),
                .text(1),
            ],
            hasInterleavedContent: false
        )
        #expect(groups == [
            .texts([0]),
            .attachment(0),
            .texts([1]),
        ])
    }
}
