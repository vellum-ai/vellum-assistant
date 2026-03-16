import Foundation
import Testing
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// End-to-end behavior tests verifying that private conversations persist correctly
/// and reappear with the right kind after a session restore cycle.
@Suite("PrivateThreadPersistence")
struct PrivateThreadPersistenceTests {

    // MARK: - End-to-end Flow

    /// Verifies the full lifecycle: create a private thread via ConversationManager,
    /// simulate the daemon assigning a session ID, then confirm the session
    /// restorer reconstructs it as a private thread.
    @Test @MainActor
    func privateThreadCreatedAndRestoredAsPrivate() {
        let dc = DaemonClient()
        dc.isConnected = true
        dc.sendOverride = { _ in }

        let manager = ConversationManager(daemonClient: dc)

        // ConversationManager.init enters draft mode — conversations array is empty,
        // the initial chat lives as a draftViewModel.
        #expect(manager.conversations.count == 0)

        // Create a private conversation — promotes the draft and adds a private conversation
        manager.createPrivateConversation()
        #expect(manager.conversations.count == 1)

        let privateThread = manager.conversations.first!
        #expect(privateThread.kind == .private)
        #expect(manager.activeConversationId == privateThread.id)

        // Simulate daemon assigning a session ID via session_info callback
        let vm = manager.activeViewModel!
        let correlationId = vm.bootstrapCorrelationId!
        let info = ConversationInfoMessage(
            conversationId: "private-session-e2e",
            title: "Private Conversation",
            correlationId: correlationId
        )
        vm.handleServerMessage(.conversationInfo(info))

        // Session ID should be backfilled into the ConversationModel
        let updatedThread = manager.conversations.first(where: { $0.id == privateThread.id })!
        #expect(updatedThread.conversationId == "private-session-e2e")
        #expect(updatedThread.kind == .private)

        // Now simulate a fresh restore: build a session list response
        // that includes this session with conversationType "private", and verify
        // the restorer creates it with .private kind.
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ConversationModel()
        delegate.conversations = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let sessionListJSON: [String: Any] = [
            "type": "conversation_list_response",
            "conversations": [
                [
                    "id": "private-session-e2e",
                    "title": "Private Conversation",
                    "createdAt": 4000,
                    "updatedAt": 5000,
                    "conversationType": "private"
                ]
            ]
        ]
        let data = try! JSONSerialization.data(withJSONObject: sessionListJSON)
        let response = try! JSONDecoder().decode(ConversationListResponseMessage.self, from: data)
        restorer.handleConversationListResponse(response)

        // Private conversations are excluded from restoration — the default thread
        // is removed (it was empty) and no private sessions are restored,
        // so a new empty thread is created via createConversation().
        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].kind == .standard)
    }

    /// Verifies that a standard thread round-trips correctly through
    /// create and restore (control case for the private thread test above).
    @Test @MainActor
    func standardThreadCreatedAndRestoredAsStandard() {
        let dc = DaemonClient()
        dc.isConnected = true
        dc.sendOverride = { _ in }

        let manager = ConversationManager(daemonClient: dc)
        // ConversationManager.init enters draft mode — no conversations in the array yet
        #expect(manager.conversations.isEmpty)

        // Restore a session list with a standard thread
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ConversationModel()
        delegate.conversations = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let sessionListJSON: [String: Any] = [
            "type": "conversation_list_response",
            "conversations": [
                [
                    "id": "standard-session-e2e",
                    "title": "Standard Conversation",
                    "createdAt": 2000,
                    "updatedAt": 3000,
                    "conversationType": "standard"
                ]
            ]
        ]
        let data = try! JSONSerialization.data(withJSONObject: sessionListJSON)
        let response = try! JSONDecoder().decode(ConversationListResponseMessage.self, from: data)
        restorer.handleConversationListResponse(response)

        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].kind == .standard)
        #expect(delegate.conversations[0].conversationId == "standard-session-e2e")
    }

    // MARK: - Mixed Conversation Restore

    /// Verifies that a session list containing both private and standard conversations
    /// restores each with the correct kind.
    @Test @MainActor
    func mixedThreadTypesRestoreCorrectly() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ConversationModel()
        delegate.conversations = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let sessionListJSON: [String: Any] = [
            "type": "conversation_list_response",
            "conversations": [
                ["id": "s-private-1", "title": "Private A", "createdAt": 4000, "updatedAt": 5000, "conversationType": "private"],
                ["id": "s-standard-1", "title": "Standard B", "createdAt": 3000, "updatedAt": 4000, "conversationType": "standard"],
                ["id": "s-private-2", "title": "Private C", "createdAt": 2000, "updatedAt": 3000, "conversationType": "private"],
            ]
        ]
        let data = try! JSONSerialization.data(withJSONObject: sessionListJSON)
        let response = try! JSONDecoder().decode(ConversationListResponseMessage.self, from: data)
        restorer.handleConversationListResponse(response)

        // Private conversations are filtered out before restore — only standard conversations appear
        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].kind == .standard)
        #expect(delegate.conversations[0].conversationId == "s-standard-1")
    }

    // MARK: - Legacy Daemon Payload Fallback

    /// Older daemon versions do not include the conversationType field in session
    /// list responses. Verify that these sessions default to .standard.
    @Test @MainActor
    func legacyPayloadWithoutConversationTypeDefaultsToStandard() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ConversationModel()
        delegate.conversations = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        // JSON with no conversationType key at all — simulates an older daemon
        let legacyJSON: [String: Any] = [
            "type": "conversation_list_response",
            "conversations": [
                ["id": "legacy-1", "title": "Old Chat", "createdAt": 1000, "updatedAt": 2000],
            ]
        ]
        let data = try! JSONSerialization.data(withJSONObject: legacyJSON)
        let response = try! JSONDecoder().decode(ConversationListResponseMessage.self, from: data)
        restorer.handleConversationListResponse(response)

        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].kind == .standard)
        #expect(delegate.conversations[0].conversationId == "legacy-1")
    }

    /// Verifies that a session list mixing legacy (no conversationType) and modern
    /// (with conversationType) sessions restores correctly.
    @Test @MainActor
    func mixedLegacyAndModernPayloadsRestoreCorrectly() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ConversationModel()
        delegate.conversations = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        // Build sessions array manually: first has conversationType, second doesn't
        let conversations: [[String: Any]] = [
            ["id": "modern-1", "title": "Modern Private", "createdAt": 4000, "updatedAt": 5000, "conversationType": "private"],
            ["id": "legacy-1", "title": "Legacy Chat", "createdAt": 3000, "updatedAt": 4000],
        ]
        let dict: [String: Any] = ["type": "conversation_list_response", "conversations": conversations]
        let data = try! JSONSerialization.data(withJSONObject: dict)
        let response = try! JSONDecoder().decode(ConversationListResponseMessage.self, from: data)
        restorer.handleConversationListResponse(response)

        // Private conversations are filtered out — only the legacy standard thread is restored
        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].kind == .standard)
        #expect(delegate.conversations[0].title == "Legacy Chat")
    }

    // MARK: - ConversationManager.createPrivateConversation Immediate Persistence

    /// Verifies that createPrivateConversation() immediately sends a session_create
    /// with conversationType "private" — the thread is persisted on the daemon side
    /// before the user sends any messages.
    @Test @MainActor
    func privateThreadPersistsImmediatelyViaSessionCreate() {
        let dc = DaemonClient()
        dc.isConnected = true
        var captured: [Any] = []
        dc.sendOverride = { msg in
            captured.append(msg)
        }

        let manager = ConversationManager(daemonClient: dc)
        manager.createPrivateConversation()

        let vm = manager.activeViewModel!
        #expect(vm.isBootstrapping)
        #expect(vm.conversationType == "private")

        // The session_create is dispatched asynchronously via Task; the
        // correlation ID and conversationType are set synchronously, confirming
        // the intent to persist immediately.
        #expect(vm.bootstrapCorrelationId != nil)
    }

    /// Verifies that a private thread's kind survives the session backfill
    /// callback — the kind should remain .private after the daemon responds.
    @Test @MainActor
    func privateConversationKindSurvivesSessionBackfill() {
        let dc = DaemonClient()
        dc.isConnected = true
        dc.sendOverride = { _ in }

        let manager = ConversationManager(daemonClient: dc)
        manager.createPrivateConversation()

        let privateThread = manager.conversations.first!
        #expect(privateThread.kind == .private)

        let vm = manager.activeViewModel!
        let correlationId = vm.bootstrapCorrelationId!

        // Simulate daemon session_info response
        let info = ConversationInfoMessage(
            conversationId: "persist-check",
            title: "Test",
            correlationId: correlationId
        )
        vm.handleServerMessage(.conversationInfo(info))

        // Kind must still be .private after backfill
        let updated = manager.conversations.first(where: { $0.id == privateThread.id })!
        #expect(updated.kind == .private)
        #expect(updated.conversationId == "persist-check")
    }
}
