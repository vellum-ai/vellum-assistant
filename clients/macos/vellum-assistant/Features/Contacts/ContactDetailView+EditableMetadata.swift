import SwiftUI
import VellumAssistantShared

// MARK: - Editable Metadata Rows

extension ContactDetailView {

    var editableRelationshipRow: some View {
        EditableMetadataRow(
            label: "Relationship",
            value: displayContact.relationship,
            isEditing: $isEditingRelationship,
            editor: {
                TextField("Relationship", text: $editedRelationship)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .textFieldStyle(.plain)
                    .onSubmit { Task { await saveRelationship() } }
            },
            onStartEditing: {
                editedRelationship = displayContact.relationship ?? ""
            },
            onCancel: {
                isEditingRelationship = false
            }
        )
    }

    var editableImportanceRow: some View {
        HStack(spacing: VSpacing.sm) {
            Text("Importance")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .frame(width: 140, alignment: .leading)

            if isEditingImportance {
                HStack(spacing: VSpacing.sm) {
                    VSlider(value: $editedImportance, range: 0...1, step: 0.1)
                        .frame(maxWidth: 160)

                    Text(String(format: "%.1f", editedImportance))
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                        .frame(width: 30, alignment: .trailing)

                    Button {
                        Task { await saveImportance() }
                    } label: {
                        Image(systemName: "checkmark")
                            .foregroundColor(VColor.success)
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Save importance")

                    Button {
                        isEditingImportance = false
                    } label: {
                        Image(systemName: "xmark")
                            .foregroundColor(VColor.textMuted)
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Cancel editing")
                }
            } else {
                Text(String(format: "%.1f", displayContact.importance))
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .onTapGesture {
                        editedImportance = displayContact.importance
                        isEditingImportance = true
                    }
            }

            Spacer()
        }
    }

    var editableResponseExpectationRow: some View {
        HStack(spacing: VSpacing.sm) {
            Text("Response expectation")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .frame(width: 140, alignment: .leading)

            if isEditingResponseExpectation {
                HStack(spacing: VSpacing.sm) {
                    Picker("", selection: $editedResponseExpectation) {
                        Text("Immediate").tag("immediate")
                        Text("Within hours").tag("within_hours")
                        Text("Within a day").tag("within_day")
                        Text("Flexible").tag("flexible")
                        Divider()
                        Text("Clear").tag("")
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .onChange(of: editedResponseExpectation) { _, newValue in
                        let currentValue = displayContact.responseExpectation ?? ""
                        guard newValue != currentValue else { return }
                        Task { await saveResponseExpectation(newValue.isEmpty ? nil : newValue) }
                    }

                    Button {
                        isEditingResponseExpectation = false
                    } label: {
                        Image(systemName: "xmark")
                            .foregroundColor(VColor.textMuted)
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Cancel editing")
                }
            } else if let expectation = displayContact.responseExpectation,
                      !expectation.isEmpty {
                Text(formatResponseExpectation(expectation))
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .onTapGesture {
                        editedResponseExpectation = expectation
                        isEditingResponseExpectation = true
                    }
            } else {
                Button {
                    editedResponseExpectation = ""
                    isEditingResponseExpectation = true
                } label: {
                    Text("+ Add")
                        .font(VFont.caption)
                        .foregroundColor(VColor.accent)
                }
                .buttonStyle(.plain)
            }

            Spacer()
        }
    }

    var editablePreferredToneRow: some View {
        EditableMetadataRow(
            label: "Preferred tone",
            value: displayContact.preferredTone,
            isEditing: $isEditingPreferredTone,
            formatValue: { capitalizeFirst($0) },
            editor: {
                TextField("Preferred tone", text: $editedPreferredTone)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .textFieldStyle(.plain)
                    .onSubmit { Task { await savePreferredTone() } }
            },
            onStartEditing: {
                editedPreferredTone = displayContact.preferredTone ?? ""
            },
            onCancel: {
                isEditingPreferredTone = false
            }
        )
    }

    // MARK: - Metadata Save Functions

    /// Returns true on success so callers can conditionally dismiss their editor.
    func saveMetadataField(
        relationship: String? = nil,
        importance: Double? = nil,
        responseExpectation: String? = nil,
        preferredTone: String? = nil
    ) async -> Bool {
        errorMessage = nil
        do {
            if let updated = try await daemonClient?.updateContact(
                contactId: displayContact.id,
                displayName: displayContact.displayName,
                relationship: relationship,
                importance: importance,
                responseExpectation: responseExpectation,
                preferredTone: preferredTone
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

    func saveRelationship() async {
        let trimmed = editedRelationship.trimmingCharacters(in: .whitespacesAndNewlines)
        let success = await saveMetadataField(relationship: trimmed)
        if success {
            isEditingRelationship = false
        }
    }

    func saveImportance() async {
        let success = await saveMetadataField(importance: editedImportance)
        if success {
            isEditingImportance = false
        }
    }

    func saveResponseExpectation(_ value: String?) async {
        let success = await saveMetadataField(responseExpectation: value ?? "")
        if success {
            isEditingResponseExpectation = false
        }
    }

    func savePreferredTone() async {
        let trimmed = editedPreferredTone.trimmingCharacters(in: .whitespacesAndNewlines)
        let success = await saveMetadataField(preferredTone: trimmed)
        if success {
            isEditingPreferredTone = false
        }
    }
}
