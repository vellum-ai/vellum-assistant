import SwiftUI
import VellumAssistantShared

// MARK: - Metadata Save Functions

extension ContactDetailView {

    /// Returns true on success so callers can conditionally dismiss their editor.
    func saveMetadataField(
        notes: String? = nil
    ) async -> Bool {
        errorMessage = nil
        do {
            if let updated = try await daemonClient?.updateContact(
                contactId: displayContact.id,
                displayName: displayContact.displayName,
                notes: notes
            ) {
                currentContact = updated
                return true
            }
            return false
        } catch {
            errorMessage = "Failed to update contact: \(error.localizedDescription)"
            return false
        }
    }

    func saveNotes() async {
        let trimmed = editedNotes.trimmingCharacters(in: .whitespacesAndNewlines)
        let success = await saveMetadataField(notes: trimmed)
        if success {
            isEditingNotes = false
        }
    }
}
