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

    init(connectionManager: GatewayConnectionManager?, eventStreamClient: EventStreamClient? = nil) {
        if let connectionManager, let eventStreamClient {
            let store = ContactsStore(connectionManager: connectionManager, eventStreamClient: eventStreamClient)
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
                    interactionCount: max(existing.interactionCount, contact.interactionCount),
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
        let base = sortedContacts
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

    /// Contacts sorted: guardian first, then humans alphabetically.
    private var sortedContacts: [ContactPayload] {
        deduplicatedContacts.sorted { a, b in
            let aOrder = a.role == "guardian" ? 0 : 1
            let bOrder = b.role == "guardian" ? 0 : 1
            if aOrder != bOrder { return aOrder < bOrder }
            return a.displayName.localizedCaseInsensitiveCompare(b.displayName) == .orderedAscending
        }
    }

    /// The guardian contact, if present.
    var guardianContact: ContactPayload? {
        deduplicatedContacts.first { $0.role == "guardian" }
    }

    /// Non-guardian contacts sorted alphabetically.
    var regularContacts: [ContactPayload] {
        deduplicatedContacts
            .filter { $0.role != "guardian" }
            .sorted { a, b in
                a.displayName.localizedCaseInsensitiveCompare(b.displayName) == .orderedAscending
            }
    }

    /// Regular contacts filtered by the current search query.
    var filteredRegularContacts: [ContactPayload] {
        let base = regularContacts
        guard !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return base
        }
        let query = searchQuery.lowercased()
        return base.filter { contact in
            if contact.displayName.lowercased().contains(query) { return true }
            return contact.channels.contains { channel in
                channel.address.lowercased().contains(query)
            }
        }
    }

    // MARK: - Actions

    /// Request the list of contacts from the daemon.
    func loadContacts() {
        contactsStore?.loadContacts()
    }
}
