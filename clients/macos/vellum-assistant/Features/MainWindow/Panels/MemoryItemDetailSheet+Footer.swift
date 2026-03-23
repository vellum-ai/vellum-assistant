import SwiftUI
import VellumAssistantShared

extension MemoryItemDetailSheet {

    var isEditFormValid: Bool {
        !editSubject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !editStatement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func save() {
        guard let baseline = editBaseline else { return }
        isSaving = true
        errorMessage = nil
        Task {
            let newSubject = editSubject != baseline.subject ? editSubject : nil
            let newStatement = editStatement != baseline.statement ? editStatement : nil
            let newKind = editKind != baseline.kind ? editKind : nil
            let newStatus = editStatus != baseline.status ? editStatus : nil
            let newImportance = editImportance != (baseline.importance ?? 0.5) ? editImportance : nil

            let result = await store.updateItem(
                id: baseline.id,
                subject: newSubject,
                statement: newStatement,
                kind: newKind,
                status: newStatus,
                importance: newImportance
            )

            isSaving = false
            if result != nil {
                editBaseline = nil
                onDismiss()
            } else {
                errorMessage = "Failed to save changes. Please try again."
            }
        }
    }
}
