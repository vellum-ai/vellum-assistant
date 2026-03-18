import SwiftUI
import VellumAssistantShared

struct MemoryItemDetailSheet: View {
    let item: MemoryItemPayload
    let store: MemoryItemsStore
    let onDismiss: () -> Void

    @State private var isEditing = false
    @State private var editSubject: String
    @State private var editStatement: String
    @State private var editKind: String
    @State private var editStatus: String
    @State private var editImportance: Double
    @State private var detailItem: MemoryItemPayload?
    @State private var isSaving = false
    @State private var showDeleteConfirm = false
    @State private var errorMessage: String?

    /// The item with full detail (supersession subjects resolved), falling back to the list item.
    private var displayItem: MemoryItemPayload { detailItem ?? item }

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

            if let errorMessage {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.circleAlert, size: 11)
                        .foregroundColor(VColor.systemNegativeStrong)
                    Text(errorMessage)
                        .font(VFont.caption)
                        .foregroundColor(VColor.systemNegativeStrong)
                }
            }
        } footer: {
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

    // MARK: - View Mode

    @ViewBuilder
    private var viewModeContent: some View {
        // Statement
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Statement")
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.contentTertiary)
            Text(displayItem.statement)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
                .textSelection(.enabled)
        }

        // Metadata
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Details")
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.contentTertiary)

            HStack(spacing: VSpacing.xs) {
                Text("Kind")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentTertiary)
                    .frame(width: 110, alignment: .leading)
                kindBadge
            }
            metadataRow(label: "Status", value: displayItem.status.capitalized)
            metadataRow(label: "Confidence", value: "\(Int(displayItem.confidence * 100))%")
            if let importance = displayItem.importance {
                metadataRow(label: "Importance", value: "\(Int(importance * 100))%")
            }

            // Verification state
            HStack(spacing: VSpacing.xs) {
                Text("Verification")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentTertiary)
                    .frame(width: 110, alignment: .leading)
                if displayItem.isUserConfirmed {
                    VIconView(.circleCheck, size: 13)
                        .foregroundColor(VColor.systemPositiveStrong)
                    Text("Confirmed by you")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.contentSecondary)
                } else if displayItem.isUserReported {
                    VIconView(.user, size: 12)
                        .foregroundColor(VColor.contentSecondary)
                    Text("Reported by you")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                } else {
                    VIconView(.sparkles, size: 13)
                        .foregroundColor(VColor.contentTertiary)
                    Text("Inferred by assistant")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.contentSecondary)
                }
            }

            metadataRow(label: "First seen", value: formattedDate(displayItem.firstSeenDate))
            metadataRow(label: "Last seen", value: formattedDate(displayItem.lastSeenDate))
            if let lastUsedDate = displayItem.lastUsedDate {
                metadataRow(label: "Last used", value: formattedDate(lastUsedDate))
            }
            metadataRow(label: "Access count", value: "\(displayItem.accessCount)")

            // Supersession
            if let supersededBySubject = displayItem.supersededBySubject {
                metadataRow(label: "Superseded by", value: supersededBySubject)
            }
            if let supersedesSubject = displayItem.supersedesSubject {
                metadataRow(label: "Supersedes", value: supersedesSubject)
            }
        }
    }

    // MARK: - Edit Mode

    @ViewBuilder
    private var editModeContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Subject
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Subject")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                VTextField(placeholder: "Brief topic or label", text: $editSubject)
            }

            // Statement
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Statement")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                TextEditor(text: $editStatement)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                    .scrollContentBackground(.hidden)
                    .padding(VSpacing.sm)
                    .background(VColor.surfaceActive)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                    .frame(minHeight: 100)
            }

            // Kind picker
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Kind")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                VDropdown(
                    placeholder: "Kind",
                    selection: $editKind,
                    options: MemoryKind.allCases.map { ($0.label, $0.rawValue) }
                )
            }

            // Status picker
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Status")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                VDropdown(
                    placeholder: "Status",
                    selection: $editStatus,
                    options: [("Active", "active"), ("Inactive", "inactive")]
                )
            }

            // Importance slider
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                HStack {
                    Text("Importance")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                    Spacer()
                    Text("\(Int(editImportance * 100))%")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                }
                VSlider(value: $editImportance, range: 0...1, step: 0.1)
            }
        }
    }


    // MARK: - Validation

    private var isEditFormValid: Bool {
        !editSubject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !editStatement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - Actions

    private func save() {
        isSaving = true
        errorMessage = nil
        Task {
            // Only send changed fields
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

    // MARK: - Helpers

    private var memoryKind: MemoryKind? {
        MemoryKind(rawValue: displayItem.kind)
    }

    @ViewBuilder
    private var kindBadge: some View {
        let color = memoryKind?.color ?? VColor.contentTertiary
        let label = memoryKind?.label ?? displayItem.kind.capitalized
        Text(label)
            .font(VFont.caption)
            .foregroundColor(VColor.contentEmphasized)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .background(color.opacity(0.2))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }

    private func metadataRow(label: String, value: String) -> some View {
        HStack(spacing: VSpacing.xs) {
            Text(label)
                .font(VFont.body)
                .foregroundColor(VColor.contentTertiary)
                .frame(width: 110, alignment: .leading)
            Text(value)
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.contentSecondary)
        }
    }

    private func formattedDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}
