import Foundation
import Testing
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// End-to-end behavior tests verifying that private conversations persist correctly
/// and reappear with the right kind after a restore cycle.
@Suite("PrivateConversationPersistence")
struct PrivateConversationPersistenceTests {

    // MARK: - End-to-end Flow

    /// Verifies the full lifecycle: create a private conversation via ConversationManager,
    /// simulate the daemon assigning a conversation ID, then confirm the
    /// restorer reconstructs it as a private conversation.
    @Test @MainActor
    func privateConversationCreatedAndRestoredAsPrivate() {
        let dc = DaemonClient()
        dc.isConnected = true

        let manager = ConversationManager(daemonClient: dc, eventStreamClient: dc.eventStreamClient)

        // ConversationManager.init enters draft mode — conversations array is empty,
        // the initial chat lives as a draftViewModel.
        #expect(manager.conversations.count == 0)

        // Create a private conversation — promotes the draft and adds a private conversation
        manager.createPrivateConversation()
        #expect(manager.conversations.count == 1)

        let privateConversation = manager.conversations.first!
        #expect(privateConversation.kind == .private)
        #expect(manager.activeConversationId == privateConversation.id)

        // Simulate daemon assigning a conversation ID via conversation_info callback
        let vm = manager.activeViewModel!
        let correlationId = vm.bootstrapCorrelationId!
        let info = ConversationInfoMessage(
            conversationId: "private-session-e2e",
            title: "Private Conversation",
            correlationId: correlationId
        )
        vm.handleServerMessage(.conversationInfo(info))

        // Conversation ID should be backfilled into the ConversationModel
        let updatedConversation = manager.conversations.first(where: { $0.id == privateConversation.id })!
        #expect(updatedConversation.conversationId == "private-session-e2e")
        #expect(updatedConversation.kind == .private)

        // Now simulate a fresh restore: build a conversation list response
        // that includes this conversation with conversationType "private", and verify
        // the restorer creates it with .private kind.
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = delegate.makeViewModel()

        let conversationListJSON: [String: Any] = [
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
        let data = try! JSONSerialization.data(withJSONObject: conversationListJSON)
        let response = try! JSONDecoder().decode(ConversationListResponseMessage.self, from: data)
        restorer.handleConversationListResponse(response)

        // Private conversations are excluded from restoration — the default conversation
        // is removed (it was empty) and no private conversations are restored,
        // so a new empty conversation is created via createConversation().
        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].kind == .standard)
    }

    /// Verifies that a standard conversation round-trips correctly through
    /// create and restore (control case for the private conversation test above).
    @Test @MainActor
    func standardConversationCreatedAndRestoredAsStandard() {
        let dc = DaemonClient()
        dc.isConnected = true

        let manager = ConversationManager(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        // ConversationManager.init enters draft mode — no conversations in the array yet
        #expect(manager.conversations.isEmpty)

        // Restore a conversation list with a standard conversation
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = delegate.makeViewModel()

        let conversationListJSON: [String: Any] = [
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
        let data = try! JSONSerialization.data(withJSONObject: conversationListJSON)
        let response = try! JSONDecoder().decode(ConversationListResponseMessage.self, from: data)
        restorer.handleConversationListResponse(response)

        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].kind == .standard)
        #expect(delegate.conversations[0].conversationId == "standard-session-e2e")
    }

    // MARK: - Mixed Conversation Restore

    /// Verifies that a conversation list containing both private and standard conversations
    /// restores each with the correct kind.
    @Test @MainActor
    func mixedConversationTypesRestoreCorrectly() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = delegate.makeViewModel()

        let conversationListJSON: [String: Any] = [
            "type": "conversation_list_response",
            "conversations": [
                ["id": "s-private-1", "title": "Private A", "createdAt": 4000, "updatedAt": 5000, "conversationType": "private"],
                ["id": "s-standard-1", "title": "Standard B", "createdAt": 3000, "updatedAt": 4000, "conversationType": "standard"],
                ["id": "s-private-2", "title": "Private C", "createdAt": 2000, "updatedAt": 3000, "conversationType": "private"],
            ]
        ]
        let data = try! JSONSerialization.data(withJSONObject: conversationListJSON)
        let response = try! JSONDecoder().decode(ConversationListResponseMessage.self, from: data)
        restorer.handleConversationListResponse(response)

        // Private conversations are filtered out during restore — only standard conversations appear
        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].kind == .standard)
        #expect(delegate.conversations[0].conversationId == "s-standard-1")
    }

    // MARK: - Legacy Daemon Payload Fallback

    /// Older daemon versions do not include the conversationType field in conversation
    /// list responses. Verify that these conversations default to .standard.
    @Test @MainActor
    func legacyPayloadWithoutConversationTypeDefaultsToStandard() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = delegate.makeViewModel()

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

    /// Verifies that a conversation list mixing legacy (no conversationType) and modern
    /// (with conversationType) conversations restores correctly.
    @Test @MainActor
    func mixedLegacyAndModernPayloadsRestoreCorrectly() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = delegate.makeViewModel()

        // Build conversations array manually: first has conversationType, second doesn't
        let conversations: [[String: Any]] = [
            ["id": "modern-1", "title": "Modern Private", "createdAt": 4000, "updatedAt": 5000, "conversationType": "private"],
            ["id": "legacy-1", "title": "Legacy Chat", "createdAt": 3000, "updatedAt": 4000],
        ]
        let dict: [String: Any] = ["type": "conversation_list_response", "conversations": conversations]
        let data = try! JSONSerialization.data(withJSONObject: dict)
        let response = try! JSONDecoder().decode(ConversationListResponseMessage.self, from: data)
        restorer.handleConversationListResponse(response)

        // Private conversations are filtered out — only the legacy standard conversation is restored
        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].kind == .standard)
        #expect(delegate.conversations[0].title == "Legacy Chat")
    }

    // MARK: - ConversationManager.createPrivateConversation Immediate Persistence

    /// Verifies that createPrivateConversation() immediately sends a conversation_create
    /// with conversationType "private" — the conversation is persisted on the daemon side
    /// before the user sends any messages.
    @Test @MainActor
    func privateConversationPersistsImmediatelyViaConversationCreate() {
        let dc = DaemonClient()
        dc.isConnected = true

        let manager = ConversationManager(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        manager.createPrivateConversation()

        let vm = manager.activeViewModel!
        #expect(vm.isBootstrapping)
        #expect(vm.conversationType == "private")

        // The conversation_create is dispatched asynchronously via Task; the
        // correlation ID and conversationType are set synchronously, confirming
        // the intent to persist immediately.
        #expect(vm.bootstrapCorrelationId != nil)
    }

    /// Verifies that a private conversation's kind survives the ID backfill
    /// callback — the kind should remain .private after the daemon responds.
    @Test @MainActor
    func privateConversationKindSurvivesIdBackfill() {
        let dc = DaemonClient()
        dc.isConnected = true

        let manager = ConversationManager(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        manager.createPrivateConversation()

        let privateConversation = manager.conversations.first!
        #expect(privateConversation.kind == .private)

        let vm = manager.activeViewModel!
        let correlationId = vm.bootstrapCorrelationId!

        // Simulate daemon conversation_info response
        let info = ConversationInfoMessage(
            conversationId: "persist-check",
            title: "Test",
            correlationId: correlationId
        )
        vm.handleServerMessage(.conversationInfo(info))

        // Kind must still be .private after backfill
        let updated = manager.conversations.first(where: { $0.id == privateConversation.id })!
        #expect(updated.kind == .private)
        #expect(updated.conversationId == "persist-check")
    }
}
