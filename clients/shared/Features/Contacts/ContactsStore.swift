import Combine
import Foundation

/// Cross-platform store for contacts data operations.
///
/// Encapsulates all communication for listing, getting, updating,
/// and deleting contacts. Platform-specific UI state (search filtering,
/// panel presentation, etc.) remains in the platform view model that
/// delegates here.
@MainActor
public final class ContactsStore: ObservableObject {

    // MARK: - Published State

    @Published public var contacts: [ContactPayload] = []
    @Published public var isLoading = false

    // MARK: - Computed Properties

    /// The guardian contact, if present.
    public var guardianContact: ContactPayload? {
        contacts.first { $0.role == "guardian" }
    }

    /// All non-guardian contacts.
    public var otherContacts: [ContactPayload] {
        contacts.filter { $0.role != "guardian" }
    }

    // MARK: - Private State

    private let daemonClient: DaemonClient
    private let eventStreamClient: EventStreamClient
    private let contactClient: ContactClientProtocol
    private var contactsChangedTask: Task<Void, Never>?
    private var subscriptionTask: Task<Void, Never>?
    private var reconnectObserver: NSObjectProtocol?

    // MARK: - Init

    public init(daemonClient: DaemonClient, eventStreamClient: EventStreamClient, contactClient: ContactClientProtocol = ContactClient()) {
        self.daemonClient = daemonClient
        self.eventStreamClient = eventStreamClient
        self.contactClient = contactClient
        subscribeToContactsChanged()
        reconnectObserver = NotificationCenter.default.addObserver(
            forName: .daemonDidReconnect,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.subscribeToContactsChanged()
            }
        }
    }

    deinit {
        subscriptionTask?.cancel()
        contactsChangedTask?.cancel()
        if let reconnectObserver {
            NotificationCenter.default.removeObserver(reconnectObserver)
        }
    }

    // MARK: - Actions

    /// Fetch the list of contacts via the gateway.
    public func loadContacts() {
        isLoading = true

        Task {
            do {
                let result = try await contactClient.fetchContactsList(limit: 500, role: nil)
                self.contacts = result
            } catch {
                // Keep existing contacts on failure
            }
            isLoading = false
        }
    }

    /// Fetch a single contact by ID and update the local list.
    public func getContact(id: String) {
        Task {
            do {
                let contact = try await contactClient.fetchContact(contactId: id)
                if let contact, let index = contacts.firstIndex(where: { $0.id == contact.id }) {
                    contacts[index] = contact
                }
            } catch {
                // Silently ignore fetch errors
            }
        }
    }

    /// Update a contact channel's status and/or policy.
    public func updateContactChannel(channelId: String, status: String? = nil, policy: String? = nil, reason: String? = nil) {
        Task {
            do {
                _ = try await contactClient.updateContactChannel(channelId: channelId, status: status, policy: policy, reason: reason)
                loadContacts()
            } catch {
                // Silently ignore update errors
            }
        }
    }

    /// Delete a contact by ID.
    public func deleteContact(id: String) {
        Task {
            do {
                let success = try await contactClient.deleteContact(contactId: id)
                if success {
                    contacts.removeAll { $0.id == id }
                }
            } catch {
                // Silently ignore delete errors
            }
        }
    }

    // MARK: - Private

    /// Subscribe to contactsChanged broadcasts with 500ms debounce.
    private func subscribeToContactsChanged() {
        subscriptionTask?.cancel()
        subscriptionTask = Task { [weak self] in
            guard let self else { return }
            let stream = self.eventStreamClient.subscribe()

            for await message in stream {
                guard !Task.isCancelled else { return }
                if case .contactsChanged = message {
                    self.contactsChangedTask?.cancel()
                    self.contactsChangedTask = Task { @MainActor [weak self] in
                        try? await Task.sleep(nanoseconds: 500_000_000)
                        guard !Task.isCancelled else { return }
                        self?.loadContacts()
                    }
                }
            }
        }
    }
}
