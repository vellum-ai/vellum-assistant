#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct MemoryItemDetailView: View {
    let item: MemoryItemPayload
    @ObservedObject var store: MemoryItemsStore
    @Environment(\.dismiss) private var dismiss

    @State private var isEditing = false
    @State private var editSubject: String
    @State private var editStatement: String
    @State private var editKind: String
    @State private var editStatus: String
    @State private var editImportance: Double
    @State private var showDeleteConfirm = false

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

            if item.supersedes != nil || item.supersededBy != nil {
                relationshipsSection
            }
        }
        .navigationTitle(item.subject)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if isEditing {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { cancelEditing() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { saveEdits() }
                }
            } else {
                ToolbarItem(placement: .primaryAction) {
                    Button("Edit") { isEditing = true }
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
                Task { await store.deleteItem(id: item.id) }
                dismiss()
            }
        } message: {
            Text("Are you sure you want to delete this memory? This action cannot be undone.")
        }
    }

    // MARK: - Content Section

    private var contentSection: some View {
        Section("Content") {
            if isEditing {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Subject")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                    TextField("Subject", text: $editSubject)
                        .font(VFont.body)
                }

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Statement")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                    TextEditor(text: $editStatement)
                        .font(VFont.body)
                        .frame(minHeight: 100)
                }
            } else {
                detailRow(label: "Subject", value: item.subject)

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Statement")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                    Text(item.statement)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentDefault)
                }
            }
        }
    }

    // MARK: - Classification Section

    private var classificationSection: some View {
        Section("Classification") {
            if isEditing {
                Picker("Kind", selection: $editKind) {
                    ForEach(MemoryKind.allCases) { kind in
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
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                    Spacer()
                    kindBadge(item.kind)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Kind: \(MemoryKind(rawValue: item.kind)?.label ?? item.kind)")

                detailRow(label: "Status", value: item.status.capitalized)
                detailRow(label: "Verification", value: formatVerificationState(item.verificationState))
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
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        Spacer()
                        Text("\(Int(editImportance * 100))%")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                    }
                    Slider(value: $editImportance, in: 0...1, step: 0.1)
                }
            } else {
                detailRow(label: "Confidence", value: "\(Int(item.confidence * 100))%")
                detailRow(label: "Importance", value: "\(Int((item.importance ?? 0) * 100))%")
                detailRow(label: "Access Count", value: "\(item.accessCount)")
            }
        }
    }

    // MARK: - Timeline Section

    private var timelineSection: some View {
        Section("Timeline") {
            detailRow(label: "First Seen", value: formatDate(item.firstSeenDate))
            detailRow(label: "Last Seen", value: formatDate(item.lastSeenDate))

            if let lastUsedDate = item.lastUsedDate {
                detailRow(label: "Last Used", value: formatDate(lastUsedDate))
            }
        }
    }

    // MARK: - Relationships Section

    private var relationshipsSection: some View {
        Section("Relationships") {
            if let supersedesSubject = item.supersedesSubject {
                detailRow(label: "Supersedes", value: supersedesSubject)
            } else if item.supersedes != nil {
                detailRow(label: "Supersedes", value: "Another memory")
            }

            if let supersededBySubject = item.supersededBySubject {
                detailRow(label: "Superseded By", value: supersededBySubject)
            } else if item.supersededBy != nil {
                detailRow(label: "Superseded By", value: "Another memory")
            }
        }
    }

    // MARK: - Actions

    private func saveEdits() {
        Task {
            _ = await store.updateItem(
                id: item.id,
                subject: editSubject != item.subject ? editSubject : nil,
                statement: editStatement != item.statement ? editStatement : nil,
                kind: editKind != item.kind ? editKind : nil,
                status: editStatus != item.status ? editStatus : nil,
                importance: editImportance != (item.importance ?? 0.5) ? editImportance : nil
            )
        }
        isEditing = false
    }

    private func cancelEditing() {
        editSubject = item.subject
        editStatement = item.statement
        editKind = item.kind
        editStatus = item.status
        editImportance = item.importance ?? 0.5
        isEditing = false
    }

    // MARK: - Helpers

    private func detailRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
            Spacer()
            Text(value)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }

    private func kindBadge(_ kind: String) -> some View {
        let memoryKind = MemoryKind(rawValue: kind)
        let color = memoryKind?.color ?? VColor.contentTertiary
        let label = memoryKind?.label ?? kind.capitalized

        return Text(label)
            .font(VFont.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(color.opacity(0.15)))
            .foregroundColor(color)
    }

    private func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    private func formatVerificationState(_ state: String) -> String {
        switch state {
        case "user_confirmed": return "User Confirmed"
        case "auto_confirmed": return "Auto Confirmed"
        case "unverified": return "Unverified"
        default: return state.capitalized
        }
    }
}
#endif
