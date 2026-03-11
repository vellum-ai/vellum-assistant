#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// A sheet that displays the output details of a completed task on iOS.
/// Adapted from macOS TaskOutputDetailView for mobile — uses NavigationStack
/// header and full-height layout instead of a fixed-size floating sheet.
struct IOSTaskOutputDetailView: View {
    let itemTitle: String
    let state: IOSTaskOutputState
    let onDismiss: () -> Void

    var body: some View {
        NavigationStack {
            contentBody
                .navigationTitle(itemTitle)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button("Done", action: onDismiss)
                    }
                }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var contentBody: some View {
        switch state {
        case .loading:
            VStack(spacing: VSpacing.md) {
                Spacer()
                ProgressView()
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
    }

    // MARK: - Metadata

    private func metadataSection(_ output: WorkItemOutputResponseOutput) -> some View {
        HStack(spacing: VSpacing.sm) {
            // Status badge
            HStack(spacing: 4) {
                Circle()
                    .fill(iosStatusColor(for: output.status))
                    .frame(width: 8, height: 8)
                Text(iosStatusLabel(for: output.status))
                    .font(VFont.caption)
                    .foregroundColor(iosStatusColor(for: output.status))
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, 4)
            .background(iosStatusColor(for: output.status).opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))

            if let completedAt = output.completedAt {
                HStack(spacing: 4) {
                    VIconView(.clock, size: 11)
                    Text(formattedDate(from: completedAt))
                        .font(VFont.caption)
                }
                .foregroundColor(VColor.textMuted)
            }

            Spacer()
        }
    }

    // MARK: - Summary

    private func summarySection(_ output: WorkItemOutputResponseOutput) -> some View {
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

    // MARK: - Helpers

    private func iosStatusColor(for status: String) -> Color {
        let normalized = WorkItemStatus(rawStatus: status)
        return TasksTableContract.statusStyle(for: normalized).color
    }

    private func iosStatusLabel(for status: String) -> String {
        let normalized = WorkItemStatus(rawStatus: status)
        return TasksTableContract.statusStyle(for: normalized).label
    }

    private func formattedDate(from timestamp: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(timestamp))
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}

#endif
