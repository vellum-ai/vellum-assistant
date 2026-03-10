import SwiftUI
import VellumAssistantShared

/// A sheet that displays the output details of a completed task.
/// Shows status, summary, and highlights with copy-to-clipboard support.
struct TaskOutputView: View {
    let itemTitle: String
    let state: TaskOutputState
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            contentBody
        }
        .frame(width: 480, height: 420)
        .background(VColor.background)
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            Text(itemTitle)
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)
                .lineLimit(1)
            Spacer()
            Button("Done", action: onDismiss)
                .buttonStyle(.plain)
                .foregroundColor(VColor.accent)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
    }

    // MARK: - Content

    @ViewBuilder
    private var contentBody: some View {
        switch state {
        case .loading:
            VStack(spacing: VSpacing.md) {
                Spacer()
                ProgressView()
                    .controlSize(.small)
                Text("Loading output…")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .error(let message):
            VStack(spacing: VSpacing.lg) {
                Spacer()
                VIconView(.triangleAlert, size: 40)
                    .foregroundColor(VColor.warning)
                Text(message)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, VSpacing.xl)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .loaded(let output):
            loadedContent(output)
        }
    }

    // MARK: - Loaded Content

    private func loadedContent(_ output: IPCWorkItemOutputResponseOutput) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                metadataSection(output)
                summarySection(output)
                if !output.highlights.isEmpty {
                    highlightsSection(output.highlights)
                }
            }
            .padding(VSpacing.lg)
        }
    }

    // MARK: - Metadata

    private func metadataSection(_ output: IPCWorkItemOutputResponseOutput) -> some View {
        HStack(spacing: VSpacing.sm) {
            HStack(spacing: 4) {
                Circle()
                    .fill(statusColor(for: output.status))
                    .frame(width: 8, height: 8)
                Text(statusLabel(for: output.status))
                    .font(VFont.caption)
                    .foregroundColor(statusColor(for: output.status))
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, 4)
            .background(statusColor(for: output.status).opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            .accessibilityLabel("Status: \(statusLabel(for: output.status))")

            if let completedAt = output.completedAt {
                HStack(spacing: 4) {
                    VIconView(.clock, size: 11)
                    Text(formattedDate(from: completedAt))
                        .font(VFont.caption)
                }
                .foregroundColor(VColor.textMuted)
            }

            Spacer()

            copyButton(text: output.summary)
        }
    }

    // MARK: - Summary

    private func summarySection(_ output: IPCWorkItemOutputResponseOutput) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Summary")
                .font(VFont.captionMedium)
                .foregroundColor(VColor.textMuted)
            Text(output.summary)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .textSelection(.enabled)
        }
    }

    // MARK: - Highlights

    private func highlightsSection(_ highlights: [String]) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Highlights")
                .font(VFont.captionMedium)
                .foregroundColor(VColor.textMuted)
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                ForEach(Array(highlights.enumerated()), id: \.offset) { _, highlight in
                    HStack(alignment: .top, spacing: VSpacing.sm) {
                        Text("\u{2022}")
                            .font(VFont.body)
                            .foregroundColor(VColor.textMuted)
                        Text(highlight)
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                            .textSelection(.enabled)
                    }
                }
            }
        }
    }

    // MARK: - Copy Button

    private func copyButton(text: String) -> some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        } label: {
            VIconView(.copy, size: 12)
                .foregroundColor(VColor.textMuted)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Copy summary")
    }

    // MARK: - Helpers

    private func statusColor(for status: String) -> Color {
        let normalized = WorkItemStatus(rawStatus: status)
        switch normalized {
        case .running:
            return VColor.accent
        case .failed, .cancelled:
            return VColor.error
        case .done, .awaitingReview:
            return VColor.success
        default:
            return VColor.textSecondary
        }
    }

    private func statusLabel(for status: String) -> String {
        let normalized = WorkItemStatus(rawStatus: status)
        return TasksTableContract.statusStyle(for: normalized).label
    }

    private func formattedDate(from timestamp: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(timestamp) / 1000.0)
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}
