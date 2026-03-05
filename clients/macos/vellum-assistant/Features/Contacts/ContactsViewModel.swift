import Foundation
import SwiftUI
import VellumAssistantShared

/// ViewModel for the contacts list, providing daemon IPC integration
/// for loading and filtering contacts.
@MainActor
final class ContactsViewModel: ObservableObject {

    // MARK: - Published State

    @Published var contacts: [ContactPayload] = []
    @Published var isLoading = false
    @Published var isCreatingContact = false
    @Published var searchQuery = ""

    // MARK: - Dependencies

    private let daemonClient: DaemonClient?

    /// Debounce task for contacts_changed events, avoiding races with
    /// in-progress channel update response handling in ContactDetailView.
    private var contactsChangedTask: Task<Void, Never>?

    // MARK: - Init

    init(daemonClient: DaemonClient?) {
        self.daemonClient = daemonClient
    }

    // MARK: - Computed Properties

    /// Contacts filtered by the current search query, matching against
    /// displayName and channel addresses.
    var filteredContacts: [ContactPayload] {
        guard !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return contacts
        }
        let query = searchQuery.lowercased()
        return contacts.filter { contact in
            if contact.displayName.lowercased().contains(query) {
                return true
            }
            return contact.channels.contains { channel in
                channel.address.lowercased().contains(query)
            }
        }
    }

    /// The guardian contact, if present.
    var guardianContact: ContactPayload? {
        filteredContacts.first { $0.role == "guardian" }
    }

    /// All non-guardian contacts from the filtered set.
    var otherContacts: [ContactPayload] {
        filteredContacts.filter { $0.role != "guardian" }
    }

    /// Whether any non-guardian contacts exist in the unfiltered list.
    /// Used for empty-state checks so search filtering doesn't
    /// incorrectly trigger the "No contacts yet" message.
    var hasNonGuardianContacts: Bool {
        contacts.contains { $0.role != "guardian" }
    }

    // MARK: - Actions

    /// Request the list of contacts from the daemon.
    func loadContacts() {
        guard let daemonClient else { return }
        isLoading = true

        daemonClient.onContactsResponse = { [weak self] response in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.isLoading = false
                if response.success, let contacts = response.contacts {
                    self.contacts = contacts
                }
            }
        }

        daemonClient.onContactsChanged = { [weak self] _ in
            guard let self else { return }
            // Debounce to let in-flight channel update responses
            // (consumed by ContactDetailView.updateChannelStatus) settle
            // before we fire a new list request.
            self.contactsChangedTask?.cancel()
            self.contactsChangedTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard !Task.isCancelled else { return }
                self?.loadContacts()
            }
        }

        do {
            try daemonClient.sendListContacts(limit: 500)
        } catch {
            isLoading = false
        }
    }
}
