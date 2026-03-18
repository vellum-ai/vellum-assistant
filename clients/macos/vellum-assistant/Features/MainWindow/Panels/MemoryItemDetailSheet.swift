import SwiftUI
import VellumAssistantShared

struct MemoryItemDetailSheet: View {
    let item: MemoryItemPayload
    let store: MemoryItemsStore
    let onDismiss: () -> Void

    @State var isEditing = false
    @State var editSubject: String
    @State var editStatement: String
    @State var editKind: String
    @State var editStatus: String
    @State var editImportance: Double
    @State var detailItem: MemoryItemPayload?
    @State var isSaving = false
    @State var showDeleteConfirm = false
    @State var errorMessage: String?

    /// The item with full detail (supersession subjects resolved), falling back to the list item.
    var displayItem: MemoryItemPayload { detailItem ?? item }

    init(item: MemoryItemPayload, store: MemoryItemsStore, onDismiss: @escaping () -> Void) {
        self.item = item
        self.store = store
        self.onDismiss = onDismiss
        _editSubject = State(initialValue: item.subject)
        _editStatement = State(initialValue: item.statement)
        _editKind = State(initialValue: item.kind)
        _editStatus = State(initialValue: item.status)
        _editImportance = State(initialValue: item.importance ?? 0.5)
    }

    var body: some View {
        VModal(title: displayItem.subject) {
            VStack(alignment: .leading, spacing: VSpacing.xl) {
                if isEditing {
                    editModeContent
                } else {
                    viewModeContent
                }
            }

        } footer: {
            VStack(spacing: VSpacing.sm) {
                if let errorMessage {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.circleAlert, size: 11)
                            .foregroundColor(VColor.systemNegativeStrong)
                        Text(errorMessage)
                            .font(VFont.caption)
                            .foregroundColor(VColor.systemNegativeStrong)
                    }
                }
                HStack {
                    if isEditing {
                        Spacer()
                        VButton(label: "Cancel", style: .outlined) {
                            isEditing = false
                            errorMessage = nil
                            editSubject = item.subject
                            editStatement = item.statement
                            editKind = item.kind
                            editStatus = item.status
                            editImportance = item.importance ?? 0.5
                        }
                        VButton(
                            label: isSaving ? "Saving..." : "Save",
                            style: .primary,
                            isDisabled: !isEditFormValid || isSaving
                        ) {
                            save()
                        }
                    } else {
                        VButton(
                            label: "Delete",
                            leftIcon: VIcon.trash.rawValue,
                            style: .dangerOutline
                        ) {
                            showDeleteConfirm = true
                        }
                        Spacer()
                        VButton(label: "Close", style: .outlined) {
                            onDismiss()
                        }
                        VButton(
                            label: "Edit",
                            leftIcon: VIcon.pencil.rawValue,
                            style: .primary
                        ) {
                            isEditing = true
                        }
                    }
                }
            }
        }
        .frame(width: 480, height: 520)
        .alert("Delete this memory?", isPresented: $showDeleteConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) {
                Task {
                    let success = await store.deleteItem(id: item.id)
                    if success {
                        onDismiss()
                    } else {
                        errorMessage = "Failed to delete memory. Please try again."
                    }
                }
            }
        } message: {
            Text("This action cannot be undone.")
        }
        .task {
            detailItem = await store.fetchDetail(id: item.id)
        }
    }
}
