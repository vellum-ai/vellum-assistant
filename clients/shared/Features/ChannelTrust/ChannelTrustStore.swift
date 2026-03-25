import Foundation

/// Cross-platform store for guardian state, channel trust/policy management,
/// and pending guardian actions.
///
/// Composes `ContactsStore` for guardian contact state and `GatewayConnectionManager`
/// for pending guardian action operations.
@MainActor @Observable
public final class ChannelTrustStore {

    // MARK: - Computed State (derived from ContactsStore)

    /// The guardian contact, derived from ContactsStore.
    public var guardianContact: ContactPayload? {
        contactsStore.contacts.first { $0.role == "guardian" }
    }

    /// Channels belonging to the guardian contact.
    public var guardianChannels: [ContactChannelPayload] {
        guardianContact?.channels ?? []
    }

    // MARK: - Published State

    /// Pending guardian decision prompts for the current conversation.
    public var pendingActions: [GuardianDecisionPromptWire] = []

    /// Whether a pending-actions fetch is in progress.
    public var isLoadingActions = false

    // MARK: - Private State

    @ObservationIgnored private let connectionManager: GatewayConnectionManager
    private let contactsStore: ContactsStore
    @ObservationIgnored private let guardianClient: GuardianClientProtocol
    @ObservationIgnored private var fetchTask: Task<Void, Never>?
    @ObservationIgnored private var decideTask: Task<Void, Never>?

    // MARK: - Init

    public init(connectionManager: GatewayConnectionManager, contactsStore: ContactsStore, guardianClient: GuardianClientProtocol = GuardianClient()) {
        self.connectionManager = connectionManager
        self.contactsStore = contactsStore
        self.guardianClient = guardianClient
    }

    deinit {
        fetchTask?.cancel()
        decideTask?.cancel()
    }

    // MARK: - Guardian Operations

    /// Verify a guardian channel by setting its status to active.
    public func verifyGuardian(channelId: String) {
        contactsStore.updateContactChannel(channelId: channelId, status: "active")
    }

    /// Revoke a guardian channel.
    public func revokeGuardian(channelId: String, reason: String? = nil) {
        contactsStore.updateContactChannel(channelId: channelId, status: "revoked", reason: reason)
    }

    // MARK: - Trust / Policy

    /// Update the policy on a guardian channel.
    public func updateChannelPolicy(channelId: String, policy: String) {
        contactsStore.updateContactChannel(channelId: channelId, policy: policy)
    }

    // MARK: - Pending Guardian Actions

    /// Fetch pending guardian action prompts for the given conversation.
    public func fetchPendingActions(conversationId: String) {
        isLoadingActions = true
        fetchTask?.cancel()
        fetchTask = Task { [weak self] in
            guard let guardianClient = self?.guardianClient else { return }
            let response = await guardianClient.fetchPendingActions(conversationId: conversationId)
            self?.pendingActions = response?.prompts ?? []
            self?.isLoadingActions = false
        }
    }

    /// Submit a decision for a pending guardian action.
    public func decideAction(requestId: String, action: String, conversationId: String? = nil) {
        decideTask?.cancel()
        decideTask = Task { [weak self] in
            guard let guardianClient = self?.guardianClient else { return }
            let response = await guardianClient.submitDecision(requestId: requestId, action: action, conversationId: conversationId)
            if response?.applied == true {
                self?.pendingActions.removeAll { $0.requestId == requestId }
            }
        }
    }
}
