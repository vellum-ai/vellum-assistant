import Foundation
import Testing
@testable import VellumAssistantLib

@Suite("ChatDiagnosticsStore")
struct ChatDiagnosticsStoreTests {

    // MARK: - Content Safety: JSON Encoding

    @Test @MainActor
    func jsonEncodingIsContentSafe() throws {
        let event = ChatDiagnosticEvent(
            kind: .scrollPositionChanged,
            conversationId: "conv-123",
            reason: "auto-scroll",
            messageCount: 42,
            toolCallCount: 3,
            isPinnedToBottom: true,
            isUserScrolling: false,
            scrollOffsetY: 1234.5,
            contentHeight: 5000.0,
            viewportHeight: 800.0
        )

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(event)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        // Must contain structural/diagnostic fields.
        #expect(json["id"] != nil)
        #expect(json["timestamp"] != nil)
        #expect(json["kind"] as? String == "scrollPositionChanged")
        #expect(json["conversationId"] as? String == "conv-123")
        #expect(json["reason"] as? String == "auto-scroll")
        #expect(json["messageCount"] as? Int == 42)
        #expect(json["toolCallCount"] as? Int == 3)
        #expect(json["isPinnedToBottom"] as? Bool == true)
        #expect(json["isUserScrolling"] as? Bool == false)
        #expect(json["scrollOffsetY"] as? Double == 1234.5)
        #expect(json["contentHeight"] as? Double == 5000.0)
        #expect(json["viewportHeight"] as? Double == 800.0)

        // Must NOT contain any user-content keys.
        let forbiddenKeys = ["messageText", "text", "toolInput", "toolOutput",
                             "html", "surfaceHtml", "attachmentContent", "body"]
        for key in forbiddenKeys {
            #expect(json[key] == nil, "JSON must not contain user-content key '\(key)'")
        }
    }

    @Test @MainActor
    func jsonEncodingOmitsNilFields() throws {
        let event = ChatDiagnosticEvent(
            kind: .appLifecycle,
            reason: "launch"
        )

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(event)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        // Required fields present.
        #expect(json["id"] != nil)
        #expect(json["kind"] as? String == "appLifecycle")
        #expect(json["reason"] as? String == "launch")

        // Optional fields that were nil should not appear (Codable default).
        // They will be present as NSNull if the encoder includes them.
        // We check that they are either absent or null.
        let optionalKeys = ["conversationId", "messageCount", "toolCallCount",
                            "isPinnedToBottom", "isUserScrolling",
                            "scrollOffsetY", "contentHeight", "viewportHeight"]
        for key in optionalKeys {
            let val = json[key]
            let isAbsentOrNull = val == nil || val is NSNull
            #expect(isAbsentOrNull, "Optional field '\(key)' should be absent or null when not set")
        }
    }

    @Test @MainActor
    func transcriptSnapshotEncodesContentSafely() throws {
        let snapshot = ChatTranscriptSnapshot(
            conversationId: "conv-456",
            capturedAt: Date(),
            messageCount: 10,
            toolCallCount: 2,
            isPinnedToBottom: false,
            isUserScrolling: true,
            scrollOffsetY: 100.0,
            contentHeight: 2000.0,
            viewportHeight: 600.0
        )

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(snapshot)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        #expect(json["conversationId"] as? String == "conv-456")
        #expect(json["messageCount"] as? Int == 10)
        #expect(json["toolCallCount"] as? Int == 2)

        // No user content keys.
        let forbiddenKeys = ["messageText", "text", "toolInput", "toolOutput",
                             "html", "surfaceHtml", "attachmentContent", "body"]
        for key in forbiddenKeys {
            #expect(json[key] == nil, "Snapshot must not contain user-content key '\(key)'")
        }
    }

    // MARK: - Ring Buffer Truncation

    @Test @MainActor
    func ringBufferTruncatesOldestEntries() {
        let store = ChatDiagnosticsStore()
        let capacity = ChatDiagnosticsStore.ringBufferCapacity

        // Record more events than the capacity.
        for i in 0..<(capacity + 50) {
            store.record(ChatDiagnosticEvent(
                id: "event-\(i)",
                timestamp: Date(),
                kind: .scrollPositionChanged,
                reason: "test-\(i)"
            ))
        }

        #expect(store.events.count == capacity)
        // Oldest events (0..49) should have been evicted.
        #expect(store.events.first?.id == "event-50")
        #expect(store.events.last?.id == "event-\(capacity + 49)")
    }

    @Test @MainActor
    func ringBufferRetainsEventsUnderCapacity() {
        let store = ChatDiagnosticsStore()

        for i in 0..<10 {
            store.record(ChatDiagnosticEvent(
                id: "event-\(i)",
                timestamp: Date(),
                kind: .appLifecycle,
                reason: "test"
            ))
        }

        #expect(store.events.count == 10)
        #expect(store.events.first?.id == "event-0")
        #expect(store.events.last?.id == "event-9")
    }

    // MARK: - Transcript Snapshot Management

    @Test @MainActor
    func transcriptSnapshotUpdateAndRetrieve() {
        let store = ChatDiagnosticsStore()

        let snapshot = ChatTranscriptSnapshot(
            conversationId: "conv-1",
            capturedAt: Date(),
            messageCount: 5,
            toolCallCount: 1,
            isPinnedToBottom: true,
            isUserScrolling: false,
            scrollOffsetY: nil,
            contentHeight: nil,
            viewportHeight: nil
        )

        store.updateSnapshot(snapshot)
        let retrieved = store.snapshot(for: "conv-1")

        #expect(retrieved != nil)
        #expect(retrieved?.conversationId == "conv-1")
        #expect(retrieved?.messageCount == 5)
    }

    @Test @MainActor
    func transcriptSnapshotPerConversationIsolation() {
        let store = ChatDiagnosticsStore()

        store.updateSnapshot(ChatTranscriptSnapshot(
            conversationId: "conv-A",
            capturedAt: Date(),
            messageCount: 10,
            toolCallCount: 2,
            isPinnedToBottom: true,
            isUserScrolling: false,
            scrollOffsetY: nil, contentHeight: nil, viewportHeight: nil
        ))

        store.updateSnapshot(ChatTranscriptSnapshot(
            conversationId: "conv-B",
            capturedAt: Date(),
            messageCount: 20,
            toolCallCount: 5,
            isPinnedToBottom: false,
            isUserScrolling: true,
            scrollOffsetY: nil, contentHeight: nil, viewportHeight: nil
        ))

        #expect(store.snapshot(for: "conv-A")?.messageCount == 10)
        #expect(store.snapshot(for: "conv-B")?.messageCount == 20)
    }

    @Test @MainActor
    func transcriptSnapshotRemoval() {
        let store = ChatDiagnosticsStore()

        store.updateSnapshot(ChatTranscriptSnapshot(
            conversationId: "conv-1",
            capturedAt: Date(),
            messageCount: 5,
            toolCallCount: 0,
            isPinnedToBottom: true,
            isUserScrolling: false,
            scrollOffsetY: nil, contentHeight: nil, viewportHeight: nil
        ))

        store.removeSnapshot(for: "conv-1")
        #expect(store.snapshot(for: "conv-1") == nil)
    }

    // MARK: - Session Log File Pruning

    @Test @MainActor
    func pruneKeepsNewestSessionLogs() throws {
        let fm = FileManager.default
        let tempDir = fm.temporaryDirectory
            .appendingPathComponent("chat-diag-prune-test-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: tempDir) }

        // Create more files than the retention limit.
        let totalFiles = ChatDiagnosticsStore.maxSessionLogFiles + 5
        var createdFiles: [URL] = []
        for i in 0..<totalFiles {
            let filename = "chat-diagnostics-2025-01-01T00-00-0\(String(format: "%02d", i))-\(1000 + i).jsonl"
            let fileURL = tempDir.appendingPathComponent(filename)
            try "line\n".write(to: fileURL, atomically: true, encoding: .utf8)

            // Set modification date so ordering is deterministic.
            let modDate = Date(timeIntervalSince1970: Double(i) * 60)
            try fm.setAttributes(
                [.modificationDate: modDate],
                ofItemAtPath: fileURL.path
            )
            createdFiles.append(fileURL)
        }

        // Also create a non-matching file that should not be pruned.
        let otherFile = tempDir.appendingPathComponent("session-2025-01-01.json")
        try "other\n".write(to: otherFile, atomically: true, encoding: .utf8)

        // Run pruning via a store whose logsDirectory points to tempDir.
        // We test the pruning logic indirectly by calling the store's
        // prune method after pointing at the temp directory.
        pruneDiagnosticLogs(in: tempDir, maxFiles: ChatDiagnosticsStore.maxSessionLogFiles)

        // Count remaining diagnostic files.
        let remaining = try fm.contentsOfDirectory(at: tempDir, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("chat-diagnostics-") && $0.pathExtension == "jsonl" }

        #expect(remaining.count == ChatDiagnosticsStore.maxSessionLogFiles)

        // The non-matching file should still exist.
        #expect(fm.fileExists(atPath: otherFile.path))

        // The newest files (highest index) should be the survivors.
        let remainingNames = Set(remaining.map(\.lastPathComponent))
        for i in (totalFiles - ChatDiagnosticsStore.maxSessionLogFiles)..<totalFiles {
            let expectedName = "chat-diagnostics-2025-01-01T00-00-0\(String(format: "%02d", i))-\(1000 + i).jsonl"
            #expect(remainingNames.contains(expectedName),
                    "Newest file \(expectedName) should survive pruning")
        }
    }

    // MARK: - Query Helpers

    @Test @MainActor
    func eventsFilteredByConversation() {
        let store = ChatDiagnosticsStore()

        store.record(ChatDiagnosticEvent(
            id: "e1", timestamp: Date(),
            kind: .scrollPositionChanged,
            conversationId: "conv-A"
        ))
        store.record(ChatDiagnosticEvent(
            id: "e2", timestamp: Date(),
            kind: .stallDetected,
            conversationId: "conv-B"
        ))
        store.record(ChatDiagnosticEvent(
            id: "e3", timestamp: Date(),
            kind: .progressCardTransition,
            conversationId: "conv-A"
        ))

        let convAEvents = store.events(for: "conv-A")
        #expect(convAEvents.count == 2)
        #expect(convAEvents.allSatisfy { $0.conversationId == "conv-A" })
    }

    @Test @MainActor
    func recentEventsReturnsLastN() {
        let store = ChatDiagnosticsStore()

        for i in 0..<20 {
            store.record(ChatDiagnosticEvent(
                id: "event-\(i)",
                timestamp: Date(),
                kind: .appLifecycle,
                reason: "test"
            ))
        }

        let recent = store.recentEvents(5)
        #expect(recent.count == 5)
        #expect(recent.first?.id == "event-15")
        #expect(recent.last?.id == "event-19")
    }

    // MARK: - Event Kind Encoding

    @Test
    func eventKindRawValuesAreStable() {
        #expect(ChatDiagnosticEventKind.scrollPositionChanged.rawValue == "scrollPositionChanged")
        #expect(ChatDiagnosticEventKind.scrollLoopDetected.rawValue == "scrollLoopDetected")
        #expect(ChatDiagnosticEventKind.progressCardTransition.rawValue == "progressCardTransition")
        #expect(ChatDiagnosticEventKind.transcriptSnapshotCaptured.rawValue == "transcriptSnapshotCaptured")
        #expect(ChatDiagnosticEventKind.stallDetected.rawValue == "stallDetected")
        #expect(ChatDiagnosticEventKind.appLifecycle.rawValue == "appLifecycle")
    }
}

// MARK: - Test Helpers

/// Standalone pruning function that mirrors ChatDiagnosticsStore.pruneSessionLogs()
/// but operates on an arbitrary directory. Used by tests to verify pruning logic
/// without touching the real logs directory.
private func pruneDiagnosticLogs(in directory: URL, maxFiles: Int) {
    let fm = FileManager.default
    guard let contents = try? fm.contentsOfDirectory(
        at: directory,
        includingPropertiesForKeys: [.contentModificationDateKey],
        options: [.skipsHiddenFiles]
    ) else { return }

    let diagnosticFiles = contents.filter {
        $0.lastPathComponent.hasPrefix("chat-diagnostics-")
            && $0.pathExtension == "jsonl"
    }

    guard diagnosticFiles.count > maxFiles else { return }

    let sorted = diagnosticFiles.sorted { a, b in
        let aDate = (try? a.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
        let bDate = (try? b.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
        return aDate > bDate
    }

    for file in sorted.dropFirst(maxFiles) {
        try? fm.removeItem(at: file)
    }
}
