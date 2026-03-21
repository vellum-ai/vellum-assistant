import Foundation
import Testing
@testable import VellumAssistantLib

@Suite("DebugStateWriterTests")
struct DebugStateWriterTests {

    // MARK: - TranscriptDiagnostics Encoding

    @Test @MainActor
    func transcriptDiagnosticsIncludedInSnapshot() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("debug-state-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        // Seed the diagnostics store with a transcript snapshot for an active conversation.
        let store = ChatDiagnosticsStore()
        let conversationId = UUID().uuidString
        let loopWarningDate = Date(timeIntervalSince1970: 1_700_000_000)
        let capturedAt = Date(timeIntervalSince1970: 1_700_000_100)

        store.updateSnapshot(ChatTranscriptSnapshot(
            conversationId: conversationId,
            capturedAt: capturedAt,
            messageCount: 42,
            toolCallCount: 7,
            isPinnedToBottom: true,
            isUserScrolling: false,
            scrollOffsetY: 1234.5,
            contentHeight: 5000.0,
            viewportHeight: 800.0,
            isNearBottom: true,
            hasReceivedScrollEvent: true,
            isPaginationInFlight: false,
            suppressionReason: "pagination-restore",
            anchorMessageId: "msg-anchor-123",
            highlightedMessageId: "msg-highlight-456",
            anchorMinY: 120.5,
            tailAnchorY: 4800.0,
            scrollViewportHeight: 790.0,
            containerWidth: 600.0,
            lastScrollToReason: "auto-scroll-bottom",
            lastLoopWarningTimestamp: loopWarningDate
        ))

        // Build a DebugSnapshot with transcript diagnostics from the seeded store.
        let transcriptSnapshot = store.snapshot(for: conversationId)!
        let diagnostics = DebugSnapshot.TranscriptDiagnostics(from: transcriptSnapshot)

        let snapshot = DebugSnapshot(
            timestamp: Date(),
            appVersion: "test",
            daemon: DebugSnapshot.DaemonState(
                isConnected: true,
                isConnecting: false,
                assistantVersion: "1.0.0"            ),
            conversations: DebugSnapshot.ConversationsState(
                activeConversationId: conversationId,
                count: 1,
                conversations: []
            ),
            activeChat: DebugSnapshot.ActiveChatState(
                conversationId: conversationId,
                isThinking: false,
                isSending: false,
                isBootstrapping: false,
                errorText: nil,
                conversationErrorCategory: nil,
                conversationErrorDebugDetails: nil,
                selectedModel: "test-model",
                messageCount: 42,
                pendingQueuedCount: 0,
                pendingAttachmentCount: 0,
                isRecording: false,
                activeSubagentCount: 0,
                transcriptDiagnostics: diagnostics
            ),
            computerUse: DebugSnapshot.ComputerUseState(
                isActive: false,
                isStarting: false
            )
        )

        // Write to the temp directory.
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(snapshot)
        let fileURL = tempDir.appendingPathComponent("debug-state.json")
        try data.write(to: fileURL, options: .atomic)

        // Read back and parse as raw JSON.
        let readData = try Data(contentsOf: fileURL)
        let json = try JSONSerialization.jsonObject(with: readData) as! [String: Any]

        // Verify the activeChat contains transcriptDiagnostics.
        let activeChat = json["activeChat"] as! [String: Any]
        let td = activeChat["transcriptDiagnostics"] as! [String: Any]

        #expect(td["messageCount"] as? Int == 42)
        #expect(td["toolCallCount"] as? Int == 7)
        #expect(td["isPinnedToBottom"] as? Bool == true)
        #expect(td["isUserScrolling"] as? Bool == false)
        #expect(td["scrollOffsetY"] as? Double == 1234.5)
        #expect(td["contentHeight"] as? Double == 5000.0)
        #expect(td["viewportHeight"] as? Double == 800.0)
        #expect(td["isNearBottom"] as? Bool == true)
        #expect(td["hasReceivedScrollEvent"] as? Bool == true)
        #expect(td["isPaginationInFlight"] as? Bool == false)
        #expect(td["suppressionReason"] as? String == "pagination-restore")
        #expect(td["anchorMessageId"] as? String == "msg-anchor-123")
        #expect(td["highlightedMessageId"] as? String == "msg-highlight-456")
        #expect(td["anchorMinY"] as? Double == 120.5)
        #expect(td["tailAnchorY"] as? Double == 4800.0)
        #expect(td["scrollViewportHeight"] as? Double == 790.0)
        #expect(td["containerWidth"] as? Double == 600.0)
        #expect(td["lastScrollToReason"] as? String == "auto-scroll-bottom")
        #expect(td["capturedAt"] != nil)
        #expect(td["lastLoopWarningTimestamp"] != nil)
    }

    @Test @MainActor
    func transcriptDiagnosticsOmitsNilExtendedFields() throws {
        // Create a minimal snapshot without extended fields.
        let store = ChatDiagnosticsStore()
        let conversationId = UUID().uuidString

        store.updateSnapshot(ChatTranscriptSnapshot(
            conversationId: conversationId,
            capturedAt: Date(),
            messageCount: 5,
            toolCallCount: 1,
            isPinnedToBottom: false,
            isUserScrolling: true,
            scrollOffsetY: nil,
            contentHeight: nil,
            viewportHeight: nil
        ))

        let transcriptSnapshot = store.snapshot(for: conversationId)!
        let diagnostics = DebugSnapshot.TranscriptDiagnostics(from: transcriptSnapshot)

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(diagnostics)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        // Core fields are present.
        #expect(json["messageCount"] as? Int == 5)
        #expect(json["isPinnedToBottom"] as? Bool == false)

        // Extended fields that were nil should be absent or null.
        let extendedKeys = [
            "isNearBottom", "hasReceivedScrollEvent", "isPaginationInFlight",
            "suppressionReason", "anchorMessageId", "highlightedMessageId",
            "anchorMinY", "tailAnchorY", "scrollViewportHeight", "containerWidth",
            "lastScrollToReason", "lastLoopWarningTimestamp"
        ]
        for key in extendedKeys {
            let val = json[key]
            let isAbsentOrNull = val == nil || val is NSNull
            #expect(isAbsentOrNull, "Optional field '\(key)' should be absent or null when not set")
        }
    }

    @Test @MainActor
    func snapshotOmitsTranscriptDiagnosticsWhenNoMatchingConversation() throws {
        // When no transcript snapshot exists for the active conversation,
        // transcriptDiagnostics should be null in the JSON.
        let snapshot = DebugSnapshot(
            timestamp: Date(),
            appVersion: "test",
            daemon: DebugSnapshot.DaemonState(
                isConnected: true,
                isConnecting: false,
                assistantVersion: "1.0.0"            ),
            conversations: DebugSnapshot.ConversationsState(
                activeConversationId: UUID().uuidString,
                count: 0,
                conversations: []
            ),
            activeChat: DebugSnapshot.ActiveChatState(
                conversationId: nil,
                isThinking: false,
                isSending: false,
                isBootstrapping: false,
                errorText: nil,
                conversationErrorCategory: nil,
                conversationErrorDebugDetails: nil,
                selectedModel: "test-model",
                messageCount: 0,
                pendingQueuedCount: 0,
                pendingAttachmentCount: 0,
                isRecording: false,
                activeSubagentCount: 0,
                transcriptDiagnostics: nil
            ),
            computerUse: DebugSnapshot.ComputerUseState(
                isActive: false,
                isStarting: false
            )
        )

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(snapshot)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        let activeChat = json["activeChat"] as! [String: Any]
        let td = activeChat["transcriptDiagnostics"]
        let isAbsentOrNull = td == nil || td is NSNull
        #expect(isAbsentOrNull, "transcriptDiagnostics should be null when no matching snapshot")
    }

    // MARK: - Content Safety

    @Test @MainActor
    func debugSnapshotContainsNoMessageContent() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("debug-state-content-safety-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let conversationId = UUID().uuidString
        let store = ChatDiagnosticsStore()

        store.updateSnapshot(ChatTranscriptSnapshot(
            conversationId: conversationId,
            capturedAt: Date(),
            messageCount: 10,
            toolCallCount: 3,
            isPinnedToBottom: true,
            isUserScrolling: false,
            scrollOffsetY: 500.0,
            contentHeight: 3000.0,
            viewportHeight: 700.0,
            isNearBottom: true,
            hasReceivedScrollEvent: true,
            isPaginationInFlight: false,
            suppressionReason: nil,
            anchorMessageId: "msg-1",
            highlightedMessageId: nil,
            anchorMinY: 100.0,
            tailAnchorY: 2900.0,
            scrollViewportHeight: 700.0,
            containerWidth: 500.0,
            lastScrollToReason: "streaming-pin",
            lastLoopWarningTimestamp: nil
        ))

        let transcriptSnapshot = store.snapshot(for: conversationId)!
        let diagnostics = DebugSnapshot.TranscriptDiagnostics(from: transcriptSnapshot)

        let snapshot = DebugSnapshot(
            timestamp: Date(),
            appVersion: "test",
            daemon: DebugSnapshot.DaemonState(
                isConnected: true,
                isConnecting: false,
                assistantVersion: nil            ),
            conversations: DebugSnapshot.ConversationsState(
                activeConversationId: conversationId,
                count: 1,
                conversations: [
                    DebugSnapshot.ConversationInfo(
                        id: conversationId,
                        title: "Test Conversation",
                        conversationId: "daemon-conv-1",
                        messageCount: 10,
                        kind: "standard",
                        isArchived: false,
                        isPinned: false
                    )
                ]
            ),
            activeChat: DebugSnapshot.ActiveChatState(
                conversationId: conversationId,
                isThinking: true,
                isSending: false,
                isBootstrapping: false,
                errorText: nil,
                conversationErrorCategory: nil,
                conversationErrorDebugDetails: nil,
                selectedModel: "test-model",
                messageCount: 10,
                pendingQueuedCount: 0,
                pendingAttachmentCount: 0,
                isRecording: false,
                activeSubagentCount: 1,
                transcriptDiagnostics: diagnostics
            ),
            computerUse: DebugSnapshot.ComputerUseState(
                isActive: false,
                isStarting: false
            )
        )

        // Write and read back.
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(snapshot)
        let fileURL = tempDir.appendingPathComponent("debug-state.json")
        try data.write(to: fileURL, options: .atomic)

        let jsonString = String(data: data, encoding: .utf8)!

        // The JSON must be valid.
        let readData = try Data(contentsOf: fileURL)
        let _ = try JSONSerialization.jsonObject(with: readData)

        // The JSON must not contain any user-content keys or values.
        let forbiddenKeys = [
            "\"messageText\"", "\"text\"", "\"toolInput\"", "\"toolOutput\"",
            "\"html\"", "\"surfaceHtml\"", "\"attachmentContent\"", "\"body\"",
            "\"userMessage\"", "\"assistantMessage\""
        ]
        for key in forbiddenKeys {
            #expect(!jsonString.contains(key),
                    "Debug snapshot must not contain user-content key \(key)")
        }
    }

    // MARK: - Field Mapping Fidelity

    @Test @MainActor
    func transcriptDiagnosticsMapsAllSnapshotFields() throws {
        let loopDate = Date(timeIntervalSince1970: 1_700_000_000)
        let capturedAt = Date(timeIntervalSince1970: 1_700_000_100)

        let snapshot = ChatTranscriptSnapshot(
            conversationId: "conv-test",
            capturedAt: capturedAt,
            messageCount: 15,
            toolCallCount: 4,
            isPinnedToBottom: false,
            isUserScrolling: true,
            scrollOffsetY: 200.0,
            contentHeight: 3000.0,
            viewportHeight: 750.0,
            isNearBottom: false,
            hasReceivedScrollEvent: true,
            isPaginationInFlight: true,
            suppressionReason: "pagination-in-progress",
            anchorMessageId: "msg-999",
            highlightedMessageId: "msg-888",
            anchorMinY: 50.0,
            tailAnchorY: 2950.0,
            scrollViewportHeight: 745.0,
            containerWidth: 580.0,
            lastScrollToReason: "pagination-restore",
            lastLoopWarningTimestamp: loopDate
        )

        let diagnostics = DebugSnapshot.TranscriptDiagnostics(from: snapshot)

        #expect(diagnostics.capturedAt == capturedAt)
        #expect(diagnostics.messageCount == 15)
        #expect(diagnostics.toolCallCount == 4)
        #expect(diagnostics.isPinnedToBottom == false)
        #expect(diagnostics.isUserScrolling == true)
        #expect(diagnostics.scrollOffsetY == 200.0)
        #expect(diagnostics.contentHeight == 3000.0)
        #expect(diagnostics.viewportHeight == 750.0)
        #expect(diagnostics.isNearBottom == false)
        #expect(diagnostics.hasReceivedScrollEvent == true)
        #expect(diagnostics.isPaginationInFlight == true)
        #expect(diagnostics.suppressionReason == "pagination-in-progress")
        #expect(diagnostics.anchorMessageId == "msg-999")
        #expect(diagnostics.highlightedMessageId == "msg-888")
        #expect(diagnostics.anchorMinY == 50.0)
        #expect(diagnostics.tailAnchorY == 2950.0)
        #expect(diagnostics.scrollViewportHeight == 745.0)
        #expect(diagnostics.containerWidth == 580.0)
        #expect(diagnostics.lastScrollToReason == "pagination-restore")
        #expect(diagnostics.lastLoopWarningTimestamp == loopDate)
    }

    // MARK: - Valid JSON Output

    @Test @MainActor
    func debugSnapshotProducesValidJSON() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("debug-state-valid-json-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let store = ChatDiagnosticsStore()
        let conversationId = UUID().uuidString

        store.updateSnapshot(ChatTranscriptSnapshot(
            conversationId: conversationId,
            capturedAt: Date(),
            messageCount: 3,
            toolCallCount: 0,
            isPinnedToBottom: true,
            isUserScrolling: false,
            scrollOffsetY: nil,
            contentHeight: nil,
            viewportHeight: nil,
            isNearBottom: true,
            hasReceivedScrollEvent: false
        ))

        let transcriptSnapshot = store.snapshot(for: conversationId)!
        let diagnostics = DebugSnapshot.TranscriptDiagnostics(from: transcriptSnapshot)

        let snapshot = DebugSnapshot(
            timestamp: Date(),
            appVersion: "1.0.0",
            daemon: DebugSnapshot.DaemonState(
                isConnected: true,
                isConnecting: false,
                assistantVersion: "2.0.0"            ),
            conversations: DebugSnapshot.ConversationsState(
                activeConversationId: conversationId,
                count: 1,
                conversations: []
            ),
            activeChat: DebugSnapshot.ActiveChatState(
                conversationId: conversationId,
                isThinking: false,
                isSending: false,
                isBootstrapping: false,
                errorText: nil,
                conversationErrorCategory: nil,
                conversationErrorDebugDetails: nil,
                selectedModel: "test-model",
                messageCount: 3,
                pendingQueuedCount: 0,
                pendingAttachmentCount: 0,
                isRecording: false,
                activeSubagentCount: 0,
                transcriptDiagnostics: diagnostics
            ),
            computerUse: DebugSnapshot.ComputerUseState(
                isActive: false,
                isStarting: false
            )
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(snapshot)
        let fileURL = tempDir.appendingPathComponent("debug-state.json")
        try data.write(to: fileURL, options: .atomic)

        // Read back and verify it's valid JSON.
        let readData = try Data(contentsOf: fileURL)
        let parsed = try JSONSerialization.jsonObject(with: readData) as! [String: Any]

        // Top-level structure is intact.
        #expect(parsed["timestamp"] != nil)
        #expect(parsed["appVersion"] as? String == "1.0.0")
        #expect(parsed["daemon"] != nil)
        #expect(parsed["conversations"] != nil)
        #expect(parsed["activeChat"] != nil)
        #expect(parsed["computerUse"] != nil)

        // Round-trip: decode back into DebugSnapshot.
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(DebugSnapshot.self, from: readData)
        #expect(decoded.activeChat?.transcriptDiagnostics != nil)
        #expect(decoded.activeChat?.transcriptDiagnostics?.messageCount == 3)
        #expect(decoded.activeChat?.transcriptDiagnostics?.isNearBottom == true)
    }

    // MARK: - Writer Directory Init

    @Test @MainActor
    func writerUsesCustomDirectory() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("debug-writer-dir-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let writer = DebugStateWriter(directory: tempDir)

        #expect(writer.fileURL.deletingLastPathComponent().path == tempDir.path)
        #expect(writer.fileURL.lastPathComponent == "debug-state.json")
        #expect(FileManager.default.fileExists(atPath: tempDir.path))
    }

    // MARK: - Non-Finite Geometry Regression

    /// Regression test: when transcript diagnostics contain sanitized non-finite
    /// geometry (anchorMinY, tailAnchorY, scrollViewportHeight, containerWidth
    /// replaced with nil via NumericSanitizer), `debug-state.json` must still
    /// serialize successfully. Before the sanitizer was adopted, raw .infinity /
    /// .nan values caused NSCocoaErrorDomain Code=4866 during JSON encoding.
    @Test @MainActor
    func debugStateSerializesWithNonFiniteGeometry() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("debug-state-nonfinite-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let store = ChatDiagnosticsStore()
        let conversationId = UUID().uuidString

        // Simulate what MessageListView produces when geometry is non-finite:
        // NumericSanitizer replaces inf/NaN with nil and records the field names.
        var sanitizer = NumericSanitizer()
        let safeAnchorMinY = sanitizer.sanitize(Double.infinity, field: "anchorMinY")
        let safeTailAnchorY = sanitizer.sanitize(Double.nan, field: "tailAnchorY")
        let safeViewportHeight = sanitizer.sanitize(-Double.infinity, field: "scrollViewportHeight")
        let safeContainerWidth = sanitizer.sanitize(Double(600), field: "containerWidth")

        // Verify the sanitizer correctly replaced non-finite values.
        #expect(safeAnchorMinY == nil)
        #expect(safeTailAnchorY == nil)
        #expect(safeViewportHeight == nil)
        #expect(safeContainerWidth == 600.0)
        #expect(sanitizer.nonFiniteFields == ["anchorMinY", "tailAnchorY", "scrollViewportHeight"])

        store.updateSnapshot(ChatTranscriptSnapshot(
            conversationId: conversationId,
            capturedAt: Date(),
            messageCount: 20,
            toolCallCount: 5,
            isPinnedToBottom: true,
            isUserScrolling: false,
            scrollOffsetY: safeAnchorMinY,
            contentHeight: nil,
            viewportHeight: safeViewportHeight,
            isNearBottom: true,
            hasReceivedScrollEvent: true,
            isPaginationInFlight: false,
            anchorMinY: safeAnchorMinY,
            tailAnchorY: safeTailAnchorY,
            scrollViewportHeight: safeViewportHeight,
            containerWidth: safeContainerWidth,
            nonFiniteFields: sanitizer.nonFiniteFields
        ))

        let transcriptSnapshot = store.snapshot(for: conversationId)!
        let diagnostics = DebugSnapshot.TranscriptDiagnostics(from: transcriptSnapshot)

        let snapshot = DebugSnapshot(
            timestamp: Date(),
            appVersion: "test",
            daemon: DebugSnapshot.DaemonState(
                isConnected: true,
                isConnecting: false,
                assistantVersion: "1.0.0"            ),
            conversations: DebugSnapshot.ConversationsState(
                activeConversationId: conversationId,
                count: 1,
                conversations: []
            ),
            activeChat: DebugSnapshot.ActiveChatState(
                conversationId: conversationId,
                isThinking: false,
                isSending: false,
                isBootstrapping: false,
                errorText: nil,
                conversationErrorCategory: nil,
                conversationErrorDebugDetails: nil,
                selectedModel: "test-model",
                messageCount: 20,
                pendingQueuedCount: 0,
                pendingAttachmentCount: 0,
                isRecording: false,
                activeSubagentCount: 0,
                transcriptDiagnostics: diagnostics
            ),
            computerUse: DebugSnapshot.ComputerUseState(
                isActive: false,
                isStarting: false
            )
        )

        // This must not throw — before the sanitizer, .infinity / .nan caused
        // NSCocoaErrorDomain Code=4866 here.
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(snapshot)
        let fileURL = tempDir.appendingPathComponent("debug-state.json")
        try data.write(to: fileURL, options: .atomic)

        // Verify the file is valid JSON and round-trips.
        let readData = try Data(contentsOf: fileURL)
        let json = try JSONSerialization.jsonObject(with: readData) as! [String: Any]
        let activeChat = json["activeChat"] as! [String: Any]
        let td = activeChat["transcriptDiagnostics"] as! [String: Any]

        // Sanitized fields should be null in the output.
        #expect(td["anchorMinY"] is NSNull || td["anchorMinY"] == nil)
        #expect(td["tailAnchorY"] is NSNull || td["tailAnchorY"] == nil)
        #expect(td["scrollViewportHeight"] is NSNull || td["scrollViewportHeight"] == nil)
        // Finite field should be preserved.
        #expect(td["containerWidth"] as? Double == 600.0)
        // nonFiniteFields should list the dropped fields.
        let droppedFields = td["nonFiniteFields"] as? [String]
        #expect(droppedFields == ["anchorMinY", "tailAnchorY", "scrollViewportHeight"])

        // Full round-trip decode must succeed.
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(DebugSnapshot.self, from: readData)
        #expect(decoded.activeChat?.transcriptDiagnostics?.anchorMinY == nil)
        #expect(decoded.activeChat?.transcriptDiagnostics?.containerWidth == 600.0)
        #expect(decoded.activeChat?.transcriptDiagnostics?.nonFiniteFields == ["anchorMinY", "tailAnchorY", "scrollViewportHeight"])
    }
}
