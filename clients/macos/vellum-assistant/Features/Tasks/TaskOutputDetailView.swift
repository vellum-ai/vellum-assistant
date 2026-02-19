import SwiftUI
import VellumAssistantShared

/// The loading/loaded/error state for fetching task output.
enum TaskOutputState {
    case loading
    case loaded(IPCWorkItemOutputResponseOutput)
    case error(String)
}

/// A sheet that displays the output details of a completed task.
/// Renders a generic layout: title, status badge, completion time,
/// summary text, and highlights as a bullet list. Works for all task
/// types with no special-case logic.
struct TaskOutputDetailView: View {
    let itemTitle: String
    let state: TaskOutputState
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().background(VColor.surfaceBorder)
            content
        }
        .frame(width: 460)
        .frame(minHeight: 320)
        .background(VColor.background)
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            Text(itemTitle)
                .font(VFont.headline)
                .foregroundColor(VColor.textPrimary)
                .lineLimit(2)
            Spacer()
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(VColor.textMuted)
                    .frame(width: 24, height: 24)
                    .background(VColor.surfaceBorder.opacity(0.5))
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        switch state {
        case .loading:
            VStack {
                Spacer()
                ProgressView()
                    .controlSize(.small)
                Text("Loading output…")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .padding(.top, VSpacing.sm)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .error(let message):
            VStack(spacing: VSpacing.md) {
                Spacer()
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 24))
                    .foregroundColor(VColor.warning)
                Text(message)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                Spacer()
            }
            .frame(maxWidth: .infinity)
            .padding(VSpacing.lg)

        case .loaded(let output):
            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    outputMetadata(output)
                    outputSummary(output)
                    if !output.highlights.isEmpty {
                        outputHighlights(output.highlights)
                    }
                }
                .padding(VSpacing.lg)
            }
        }
    }

    // MARK: - Output Sections

    private func outputMetadata(_ output: IPCWorkItemOutputResponseOutput) -> some View {
        HStack(spacing: VSpacing.md) {
            // Status badge
            HStack(spacing: VSpacing.xs) {
                Circle()
                    .fill(TaskOutputRenderer.statusColor(for: output.status))
                    .frame(width: 8, height: 8)
                Text(TaskOutputRenderer.statusLabel(for: output.status))
                    .font(VFont.caption)
                    .foregroundColor(TaskOutputRenderer.statusColor(for: output.status))
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .background(TaskOutputRenderer.statusColor(for: output.status).opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))

            // Completion time
            if let completedAt = output.completedAt {
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "clock")
                        .font(.system(size: 10))
                    Text(TaskOutputRenderer.formattedDate(from: completedAt))
                        .font(VFont.caption)
                }
                .foregroundColor(VColor.textMuted)
            }

            Spacer()
        }
    }

    private func outputSummary(_ output: IPCWorkItemOutputResponseOutput) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Summary")
                .font(VFont.captionMedium)
                .foregroundColor(VColor.textMuted)
            Text(output.summary)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .textSelection(.enabled)
        }
    }

    private func outputHighlights(_ highlights: [String]) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
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
}

// MARK: - Preview

#if DEBUG
struct TaskOutputDetailViewPreview: PreviewProvider {
    /// Helper to create preview output data via JSON decoding, since
    /// the generated struct's memberwise init is module-internal.
    private static func makeOutput(
        title: String, status: String, summary: String, highlights: [String],
        completedAt: Int? = nil
    ) -> IPCWorkItemOutputResponseOutput {
        var dict: [String: Any] = [
            "title": title,
            "status": status,
            "summary": summary,
            "highlights": highlights,
        ]
        if let ts = completedAt { dict["completedAt"] = ts }
        let data = try! JSONSerialization.data(withJSONObject: dict)
        return try! JSONDecoder().decode(IPCWorkItemOutputResponseOutput.self, from: data)
    }

    static var previews: some View {
        Group {
            ZStack {
                VColor.background.ignoresSafeArea()
                TaskOutputDetailView(
                    itemTitle: "Review inbox emails",
                    state: .loaded(makeOutput(
                        title: "Review inbox emails",
                        status: "done",
                        summary: "Processed 12 emails. Drafted 3 replies, archived 7 newsletters, and flagged 2 items requiring follow-up.",
                        highlights: [
                            "Replied to meeting request from Sarah \u{2014} confirmed Thursday 2pm",
                            "Flagged contract renewal from Legal \u{2014} needs review by Friday",
                            "Archived 7 promotional newsletters",
                        ],
                        completedAt: Int(Date().timeIntervalSince1970)
                    )),
                    onDismiss: {}
                )
            }
            .previewDisplayName("Loaded")

            ZStack {
                VColor.background.ignoresSafeArea()
                TaskOutputDetailView(
                    itemTitle: "Process support tickets",
                    state: .loading,
                    onDismiss: {}
                )
            }
            .previewDisplayName("Loading")

            ZStack {
                VColor.background.ignoresSafeArea()
                TaskOutputDetailView(
                    itemTitle: "Failed task",
                    state: .error("Output not available for this task."),
                    onDismiss: {}
                )
            }
            .previewDisplayName("Error")
        }
    }
}
#endif
