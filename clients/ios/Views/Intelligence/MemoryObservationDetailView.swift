#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct MemoryObservationDetailView: View {
    let observation: MemoryObservationPayload
    @ObservedObject var store: SimplifiedMemoryStore
    @Environment(\.dismiss) private var dismiss
    @State private var showDeleteConfirm = false
    @State private var showDeleteError = false

    var body: some View {
        Form {
            contentSection
            detailsSection
            timelineSection
        }
        .navigationTitle("Observation")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
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
        .alert("Delete Observation?", isPresented: $showDeleteConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) {
                Task {
                    let success = await store.deleteObservation(id: observation.id)
                    if success {
                        dismiss()
                    } else {
                        showDeleteError = true
                    }
                }
            }
        } message: {
            Text("Are you sure you want to delete this observation? This action cannot be undone.")
        }
        .alert("Delete Failed", isPresented: $showDeleteError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Unable to delete observation. Please try again.")
        }
    }

    // MARK: - Content Section

    private var contentSection: some View {
        Section("Content") {
            Text(observation.content)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
        }
    }

    // MARK: - Details Section

    private var detailsSection: some View {
        Section("Details") {
            detailRow(label: "Role", value: observation.role.capitalized)
            detailRow(label: "Modality", value: observation.modality.capitalized)
            if let source = observation.source {
                detailRow(label: "Source", value: source)
            }
            if let title = observation.conversationTitle, !title.isEmpty {
                detailRow(label: "Conversation", value: title)
            }
        }
    }

    // MARK: - Timeline Section

    private var timelineSection: some View {
        Section("Timeline") {
            detailRow(label: "Created", value: formatDate(observation.createdDate))
        }
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

    private func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}
#endif
