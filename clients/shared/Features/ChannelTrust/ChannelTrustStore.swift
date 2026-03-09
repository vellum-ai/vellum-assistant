import Combine
import Foundation

/// Cross-platform store for guardian state, channel trust/policy management,
/// and pending guardian actions.
///
/// Composes `ContactsStore` for guardian contact state and `DaemonClient`
/// for pending guardian action operations.
@MainActor
public final class ChannelTrustStore: ObservableObject {

    // MARK: - Published State

    /// The guardian contact, forwarded from ContactsStore.
    @Published public var guardianContact: ContactPayload?

    /// Channels belonging to the guardian contact.
    @Published public var guardianChannels: [ContactChannelPayload] = []

    /// Pending guardian decision prompts for the current conversation.
    @Published public var pendingActions: [GuardianDecisionPromptWire] = []

    /// Whether a pending-actions fetch is in progress.
    @Published public var isLoadingActions = false

    // MARK: - Private State

    private let daemonClient: DaemonClient
    private let contactsStore: ContactsStore
    private var cancellables = Set<AnyCancellable>()
    private var fetchTask: Task<Void, Never>?
    private var decideTask: Task<Void, Never>?

    // MARK: - Init

    public init(daemonClient: DaemonClient, contactsStore: ContactsStore) {
        self.daemonClient = daemonClient
        self.contactsStore = contactsStore

        // Forward guardian state from ContactsStore
        contactsStore.$contacts
            .map { contacts in contacts.first { $0.role == "guardian" } }
            .assign(to: &$guardianContact)

        $guardianContact
            .map { $0?.channels ?? [] }
            .assign(to: &$guardianChannels)
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
            guard let self else { return }
            let stream = daemonClient.subscribe()
            do {
                try daemonClient.sendGuardianActionsPendingRequest(conversationId: conversationId)
            } catch {
                self.isLoadingActions = false
                return
            }
            for await message in stream {
                guard let self else { return }
                if case .guardianActionsPendingResponse(let response) = message {
                    self.pendingActions = response.prompts
                    self.isLoadingActions = false
                    return
                }
            }
            guard let self else { return }
            self.isLoadingActions = false
        }
    }

    /// Submit a decision for a pending guardian action.
    public func decideAction(requestId: String, action: String, conversationId: String? = nil) {
        decideTask?.cancel()
        decideTask = Task { [weak self] in
            guard let self else { return }
            let stream = daemonClient.subscribe()
            do {
                try daemonClient.sendGuardianActionDecision(requestId: requestId, action: action, conversationId: conversationId)
            } catch { return }
            for await message in stream {
                guard let self else { return }
                if case .guardianActionDecisionResponse(let response) = message {
                    if response.applied {
                        self.pendingActions.removeAll { $0.requestId == requestId }
                    }
                    return
                }
            }
        }
    }
}
