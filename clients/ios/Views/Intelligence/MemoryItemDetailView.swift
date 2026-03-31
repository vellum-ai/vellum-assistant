#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct MemoryItemDetailView: View {
    let item: MemoryItemPayload
    var store: MemoryItemsStore
    @Environment(\.dismiss) private var dismiss

    @State private var isEditing = false
    @State private var isSaving = false
    @State private var editSubject: String
    @State private var editStatement: String
    @State private var editKind: String
    @State private var editStatus: String
    @State private var editImportance: Double
    @State private var editBaseline: MemoryItemPayload?
    @State private var showDeleteConfirm = false
    @State private var showSaveError = false
    @State private var showDeleteError = false

    /// Live item data from store (updates after save).
    private var liveItem: MemoryItemPayload {
        store.items.first { $0.id == item.id } ?? item
    }

    init(item: MemoryItemPayload, store: MemoryItemsStore) {
        self.item = item
        self.store = store
        _editSubject = State(initialValue: item.subject)
        _editStatement = State(initialValue: item.statement)
        _editKind = State(initialValue: item.kind)
        _editStatus = State(initialValue: item.status)
        _editImportance = State(initialValue: item.importance ?? 0.5)
    }

    var body: some View {
        Form {
            contentSection
            classificationSection
            metricsSection
            timelineSection

            if liveItem.supersedes != nil || liveItem.supersededBy != nil {
                relationshipsSection
            }
        }
        .navigationTitle(liveItem.subject)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if isEditing {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { cancelEditing() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { saveEdits() }
                        .disabled(isSaving)
                }
            } else {
                ToolbarItem(placement: .primaryAction) {
                    Button("Edit") {
                        editBaseline = liveItem
                        editSubject = liveItem.subject
                        editStatement = liveItem.statement
                        editKind = liveItem.kind
                        editStatus = liveItem.status
                        editImportance = liveItem.importance ?? 0.5
                        isEditing = true
                    }
                }
                ToolbarItem(placement: .secondaryAction) {
                    Button(role: .destructive) {
                        showDeleteConfirm = true
                    } label: {
                        Label {
                            Text("Delete")
                        } icon: {
                            VIconView(.trash, size: 16)
                        }
                    }
                }
            }
        }
        .alert("Delete Memory?", isPresented: $showDeleteConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) {
                Task {
                    let success = await store.deleteItem(id: liveItem.id)
                    if success {
                        dismiss()
                    } else {
                        showDeleteError = true
                    }
                }
            }
        } message: {
            Text("Are you sure you want to delete this memory? This action cannot be undone.")
        }
        .alert("Save Failed", isPresented: $showSaveError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Unable to save changes. Please try again.")
        }
        .alert("Delete Failed", isPresented: $showDeleteError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Unable to delete memory. Please try again.")
        }
        .task {
            await store.fetchDetail(id: item.id)
        }
    }

    // MARK: - Content Section

    private var contentSection: some View {
        Section("Content") {
            if isEditing {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Subject")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    TextField("Subject", text: $editSubject)
                        .font(VFont.bodyMediumLighter)
                }

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Statement")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    TextEditor(text: $editStatement)
                        .font(VFont.bodyMediumLighter)
                        .frame(minHeight: 100)
                }
            } else {
                detailRow(label: "Subject", value: liveItem.subject)

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Statement")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    Text(liveItem.statement)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentDefault)
                }
            }
        }
    }

    // MARK: - Classification Section

    private var classificationSection: some View {
        Section("Classification") {
            if isEditing {
                Picker("Kind", selection: $editKind) {
                    ForEach(MemoryKind.editableKinds(current: editBaseline?.kind ?? liveItem.kind)) { kind in
                        Text(kind.label).tag(kind.rawValue)
                    }
                }
                .pickerStyle(.menu)

                Picker("Status", selection: $editStatus) {
                    Text("Active").tag("active")
                    Text("Inactive").tag("inactive")
                }
                .pickerStyle(.menu)
            } else {
                HStack {
                    Text("Kind")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    Spacer()
                    kindBadge(liveItem.kind)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Kind: \(MemoryKind(rawValue: liveItem.kind)?.label ?? liveItem.kind)")

                detailRow(label: "Status", value: liveItem.status.capitalized)
                if let sourceType = liveItem.sourceType {
                    detailRow(label: "Source", value: sourceType.capitalized)
                }

                if let scopeLabel = liveItem.scopeLabel {
                    HStack {
                        Text("Scope")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                        Spacer()
                        HStack(spacing: VSpacing.xxs) {
                            VIconView(.lock, size: 12)
                                .foregroundStyle(VColor.contentSecondary)
                            Text(scopeLabel)
                                .font(VFont.bodyMediumLighter)
                                .foregroundStyle(VColor.contentDefault)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Scope: \(scopeLabel)")
                }
            }
        }
    }

    // MARK: - Metrics Section

    private var metricsSection: some View {
        Section("Metrics") {
            if isEditing {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack {
                        Text("Importance")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                        Spacer()
                        Text("\(Int(editImportance * 100))%")
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentDefault)
                    }
                    Slider(value: $editImportance, in: 0...1, step: 0.1)
                }
            } else {
                detailRow(label: "Confidence", value: "\(Int((liveItem.confidence ?? 0) * 100))%")
                detailRow(label: "Importance", value: "\(Int((liveItem.importance ?? 0) * 100))%")
                if let fidelity = liveItem.fidelity {
                    detailRow(label: "Fidelity", value: fidelity.capitalized)
                }
                if let count = liveItem.reinforcementCount, count > 0 {
                    detailRow(label: "Reinforced", value: "\(count) time\(count == 1 ? "" : "s")")
                }
            }
        }
    }

    // MARK: - Timeline Section

    private var timelineSection: some View {
        Section("Timeline") {
            detailRow(label: "First Seen", value: formatDate(liveItem.firstSeenDate))
            detailRow(label: "Last Seen", value: formatDate(liveItem.lastSeenDate))

            if let lastUsedDate = liveItem.lastUsedDate {
                detailRow(label: "Last Used", value: formatDate(lastUsedDate))
            }
        }
    }

    // MARK: - Relationships Section

    private var relationshipsSection: some View {
        Section("Relationships") {
            if let supersedesSubject = liveItem.supersedesSubject {
                detailRow(label: "Supersedes", value: supersedesSubject)
            } else if liveItem.supersedes != nil {
                detailRow(label: "Supersedes", value: "Another memory")
            }

            if let supersededBySubject = liveItem.supersededBySubject {
                detailRow(label: "Superseded By", value: supersededBySubject)
            } else if liveItem.supersededBy != nil {
                detailRow(label: "Superseded By", value: "Another memory")
            }
        }
    }

    // MARK: - Actions

    private func saveEdits() {
        guard !isSaving, let baseline = editBaseline else { return }
        isSaving = true
        Task {
            let result = await store.updateItem(
                id: baseline.id,
                subject: editSubject != baseline.subject ? editSubject : nil,
                statement: editStatement != baseline.statement ? editStatement : nil,
                kind: editKind != baseline.kind ? editKind : nil,
                status: editStatus != baseline.status ? editStatus : nil,
                importance: editImportance != (baseline.importance ?? 0.5) ? editImportance : nil
            )
            isSaving = false
            if result != nil {
                isEditing = false
                editBaseline = nil
            } else {
                showSaveError = true
            }
        }
    }

    private func cancelEditing() {
        editSubject = liveItem.subject
        editStatement = liveItem.statement
        editKind = liveItem.kind
        editStatus = liveItem.status
        editImportance = liveItem.importance ?? 0.5
        isEditing = false
        editBaseline = nil
    }

    // MARK: - Helpers

    private func detailRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
            Spacer()
            Text(value)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }

    private func kindBadge(_ kind: String) -> some View {
        let memoryKind = MemoryKind(rawValue: kind)
        let color = memoryKind?.color ?? VColor.contentTertiary
        let label = memoryKind?.label ?? kind.capitalized

        return Text(label)
            .font(VFont.labelDefault)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(color.opacity(0.15)))
            .foregroundStyle(color)
    }

    private func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

}
#endif
