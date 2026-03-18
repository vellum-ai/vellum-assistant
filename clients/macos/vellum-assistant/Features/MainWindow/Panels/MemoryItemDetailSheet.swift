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
        VStack(spacing: 0) {
            header
            Divider().background(VColor.borderBase)

            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    if isEditing {
                        editModeContent
                    } else {
                        viewModeContent
                    }
                }
                .padding(VSpacing.xl)
            }

            if let errorMessage {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.circleAlert, size: 11)
                        .foregroundColor(VColor.systemNegativeStrong)
                    Text(errorMessage)
                        .font(VFont.caption)
                        .foregroundColor(VColor.systemNegativeStrong)
                }
                .padding(.horizontal, VSpacing.xl)
                .padding(.bottom, VSpacing.sm)
            }

            footer
        }
        .frame(width: 480, height: 520)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
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
