import Combine
import Foundation

/// Cross-platform store for contacts data operations.
///
/// Encapsulates all daemon communication for listing, getting, updating,
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
    private var contactsChangedTask: Task<Void, Never>?
    private var subscriptionTask: Task<Void, Never>?

    // MARK: - Init

    public init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
        subscribeToContactsChanged()
    }

    deinit {
        subscriptionTask?.cancel()
        contactsChangedTask?.cancel()
    }

    // MARK: - Actions

    /// Request the list of contacts from the daemon.
    public func loadContacts() {
        isLoading = true

        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.sendListContacts(limit: 500)
            } catch {
                isLoading = false
                return
            }

            let result = await stream.firstMatch { message -> [ContactPayload]? in
                if case .contactsResponse(let response) = message {
                    guard response.contacts != nil else { return nil }
                    return response.contacts ?? []
                }
                return nil
            }
            self.contacts = result ?? self.contacts
            isLoading = false
        }
    }

    /// Request a single contact by ID.
    public func getContact(id: String) {
        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.sendGetContact(contactId: id)
            } catch {
                return
            }

            let contact = await stream.firstMatch { message -> ContactPayload? in
                if case .contactsResponse(let response) = message {
                    guard response.contact != nil else { return nil }
                    return response.contact
                }
                return nil
            }
            if let contact, let index = contacts.firstIndex(where: { $0.id == contact.id }) {
                contacts[index] = contact
            }
        }
    }

    /// Update a contact channel's status and/or policy.
    public func updateContactChannel(channelId: String, status: String? = nil, policy: String? = nil, reason: String? = nil) {
        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.sendUpdateContactChannel(channelId: channelId, status: status, policy: policy, reason: reason)
            } catch {
                return
            }

            let success = await stream.firstMatch { message -> Bool? in
                if case .contactsResponse(let response) = message {
                    guard response.contact != nil || !response.success else { return nil }
                    return response.success
                }
                return nil
            }
            if success == true {
                loadContacts()
            }
        }
    }

    /// Request deletion of a contact by ID.
    public func deleteContact(id: String) {
        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.sendDeleteContact(contactId: id)
            } catch {
                return
            }

            let success = await stream.firstMatch { message -> Bool? in
                if case .contactsResponse(let response) = message {
                    guard response.contact == nil && response.contacts == nil else { return nil }
                    return response.success
                }
                return nil
            }
            if success == true {
                contacts.removeAll { $0.id == id }
            }
        }
    }

    // MARK: - Private

    /// Subscribe to contactsChanged broadcasts with 500ms debounce.
    private func subscribeToContactsChanged() {
        subscriptionTask = Task { [weak self] in
            guard let daemonClient = self?.daemonClient else { return }
            let stream = daemonClient.subscribe()

            for await message in stream {
                guard let self, !Task.isCancelled else { return }
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
