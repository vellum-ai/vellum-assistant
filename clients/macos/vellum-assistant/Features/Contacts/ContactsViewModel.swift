import Combine
import Foundation
import SwiftUI
import VellumAssistantShared

/// ViewModel for the contacts list, providing daemon HTTP integration
/// for loading and filtering contacts. Delegates data operations to
/// the shared ContactsStore.
@MainActor
final class ContactsViewModel: ObservableObject {

    // MARK: - Published State

    @Published var contacts: [ContactPayload] = []
    @Published var isLoading = false
    @Published var isCreatingContact = false
    @Published var searchQuery = ""

    // MARK: - Dependencies

    let contactsStore: ContactsStore?

    // MARK: - Init

    init(daemonClient: DaemonClient?) {
        if let daemonClient {
            let store = ContactsStore(daemonClient: daemonClient)
            self.contactsStore = store

            store.$contacts
                .assign(to: &$contacts)
            store.$isLoading
                .assign(to: &$isLoading)
        } else {
            self.contactsStore = nil
        }
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
        contactsStore?.loadContacts()
    }
}
