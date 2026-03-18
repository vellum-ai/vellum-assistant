import SwiftUI
import VellumAssistantShared

extension MemoryItemDetailSheet {

    var footer: some View {
        HStack {
            if isEditing {
                Button {
                    isEditing = false
                    errorMessage = nil
                    editSubject = item.subject
                    editStatement = item.statement
                    editKind = item.kind
                    editStatus = item.status
                    editImportance = item.importance ?? 0.5
                } label: {
                    Text("Cancel")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.contentSecondary)
                }
                .buttonStyle(.plain)

                Spacer()

                VButton(
                    label: isSaving ? "Saving..." : "Save",
                    style: .primary,
                    isDisabled: !isEditFormValid || isSaving
                ) {
                    save()
                }
            } else {
                Spacer()
            }
        }
        .padding(.horizontal, VSpacing.xl)
        .padding(.vertical, VSpacing.lg)
    }

    var isEditFormValid: Bool {
        !editSubject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !editStatement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func save() {
        isSaving = true
        errorMessage = nil
        Task {
            let newSubject = editSubject != item.subject ? editSubject : nil
            let newStatement = editStatement != item.statement ? editStatement : nil
            let newKind = editKind != item.kind ? editKind : nil
            let newStatus = editStatus != item.status ? editStatus : nil
            let newImportance = editImportance != (item.importance ?? 0.5) ? editImportance : nil

            let result = await store.updateItem(
                id: item.id,
                subject: newSubject,
                statement: newStatement,
                kind: newKind,
                status: newStatus,
                importance: newImportance
            )

            isSaving = false
            if result != nil {
                onDismiss()
            } else {
                errorMessage = "Failed to save changes. Please try again."
            }
        }
    }
}
