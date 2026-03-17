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

    /// Contacts deduplicated by role+displayName, with channels merged.
    /// The daemon may return separate entries per channel for the same person
    /// (especially guardians).
    var deduplicatedContacts: [ContactPayload] {
        var seen: [String: Int] = [:]
        var result: [ContactPayload] = []
        for contact in contacts {
            // Guardian contacts are always unique by role; others by id
            let key = contact.role == "guardian" ? "guardian" : contact.id
            if let idx = seen[key] {
                let existing = result[idx]
                let mergedChannels = existing.channels + contact.channels
                result[idx] = ContactPayload(
                    id: existing.id,
                    displayName: existing.displayName,
                    role: existing.role,
                    notes: existing.notes ?? contact.notes,
                    contactType: existing.contactType ?? contact.contactType,
                    lastInteraction: existing.lastInteraction ?? contact.lastInteraction,
                    interactionCount: existing.interactionCount + contact.interactionCount,
                    channels: mergedChannels
                )
            } else {
                seen[key] = result.count
                result.append(contact)
            }
        }
        return result
    }

    /// All contacts filtered by the current search query, matching
    /// against displayName and channel addresses.
    var filteredContacts: [ContactPayload] {
        let base = deduplicatedContacts
        guard !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return base
        }
        let query = searchQuery.lowercased()
        return base.filter { contact in
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
        deduplicatedContacts.first { $0.role == "guardian" }
    }

    // MARK: - Actions

    /// Request the list of contacts from the daemon.
    func loadContacts() {
        contactsStore?.loadContacts()
    }
}
