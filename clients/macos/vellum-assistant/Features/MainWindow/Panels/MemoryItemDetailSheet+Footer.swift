import SwiftUI
import VellumAssistantShared

extension MemoryItemDetailSheet {

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
