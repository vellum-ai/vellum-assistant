import SwiftUI
import VellumAssistantShared

// MARK: - Editable Metadata Rows

extension ContactDetailView {

    var editableNotesRow: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack {
                Text("Notes")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                Spacer()
                if isEditingNotes {
                    HStack(spacing: VSpacing.sm) {
                        Button {
                            Task { await saveNotes() }
                        } label: {
                            Image(systemName: "checkmark")
                                .foregroundColor(VColor.success)
                                .font(.system(size: 12, weight: .semibold))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Save notes")

                        Button {
                            isEditingNotes = false
                        } label: {
                            Image(systemName: "xmark")
                                .foregroundColor(VColor.textMuted)
                                .font(.system(size: 12, weight: .semibold))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Cancel editing")
                    }
                }
            }

            if isEditingNotes {
                TextEditor(text: $editedNotes)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 80, maxHeight: 200)
                    .padding(VSpacing.xs)
                    .background(VColor.inputBackground)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            } else if let notes = displayContact.notes, !notes.isEmpty {
                Text(notes)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .onTapGesture {
                        editedNotes = notes
                        isEditingNotes = true
                    }
            } else {
                Button {
                    editedNotes = ""
                    isEditingNotes = true
                } label: {
                    Text("+ Add notes")
                        .font(VFont.caption)
                        .foregroundColor(VColor.accent)
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - Metadata Save Functions

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
