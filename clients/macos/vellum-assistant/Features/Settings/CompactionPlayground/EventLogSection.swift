import SwiftUI
import VellumAssistantShared

/// Event Log subsection of the Compaction Playground tab.
///
/// Renders `ChatViewModel.compactionEventLog` for the active conversation as
/// a most-recent-first list. The log is populated by the existing
/// `context_compacting`, `context_compacted`, `compaction_circuit_open`, and
/// `compaction_circuit_closed` SSE handlers in `ChatActionHandler`, so no
/// new subscription is needed here.
///
/// The buffer trim (50 entries) is centralized in
/// `ChatViewModel.appendCompactionEvent(_:)` — this view only reads.
struct EventLogSection: View {
    let conversationId: String?
    let conversationManager: ConversationManager

    private static let timestampFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .medium
        return formatter
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Compaction Event Log")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)

            Text("Streamed from the active conversation's SSE events.")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)

            if let viewModel = conversationManager.activeViewModel {
                // ChatViewModel is `@Observable`, so reading
                // `viewModel.compactionEventLog` directly from a SwiftUI body
                // registers the observation dependency and triggers re-renders
                // when `appendCompactionEvent` mutates the array.
                logContent(viewModel: viewModel)
            } else {
                emptyState(
                    "Open a conversation in the main window to see compaction events."
                )
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
    }

    // MARK: - Subviews

    @ViewBuilder
    private func logContent(viewModel: ChatViewModel) -> some View {
        if viewModel.compactionEventLog.isEmpty {
            emptyState(
                "No compaction events yet — trigger one from the sections above."
            )
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    ForEach(viewModel.compactionEventLog.reversed()) { entry in
                        row(entry: entry)
                    }
                }
            }
            .frame(maxHeight: 240)

            HStack {
                Spacer()
                VButton(label: "Clear", style: .outlined) {
                    viewModel.compactionEventLog = []
                }
            }
        }
    }

    @ViewBuilder
    private func row(entry: CompactionEventLogEntry) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            Text(Self.timestampFormatter.string(from: entry.timestamp))
                .font(VFont.bodySmallDefault.monospaced())
                .foregroundStyle(VColor.contentTertiary)
                .frame(width: 72, alignment: .leading)

            kindPill(entry.kind)

            Text(entry.summary)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentDefault)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func kindPill(_ kind: String) -> some View {
        Text(kind)
            .font(VFont.labelSmall)
            .foregroundStyle(VColor.contentDefault)
            .padding(.horizontal, VSpacing.xs)
            .padding(.vertical, 2)
            .background(
                RoundedRectangle(cornerRadius: 4)
                    .fill(pillColor(for: kind).opacity(0.2))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 4)
                    .stroke(pillColor(for: kind), lineWidth: 1)
            )
    }

    private func pillColor(for kind: String) -> Color {
        switch kind {
        case "compacting": return VColor.contentTertiary
        case "compacted": return VColor.systemPositiveStrong
        case "circuit_open": return VColor.systemNegativeStrong
        case "circuit_closed": return VColor.systemMidStrong
        default: return VColor.contentTertiary
        }
    }

    @ViewBuilder
    private func emptyState(_ text: String) -> some View {
        Text(text)
            .font(VFont.bodySmallDefault)
            .foregroundStyle(VColor.contentSecondary)
    }
}
