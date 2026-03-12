import SwiftUI
import VellumAssistantShared

struct SettingsArchivedThreadsTab: View {
    @ObservedObject var threadManager: ThreadManager

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            if threadManager.archivedThreads.isEmpty {
                VEmptyState(
                    title: "No archived threads",
                    subtitle: "Threads you archive will appear here.",
                    icon: VIcon.archive.rawValue
                )
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(threadManager.archivedThreads.enumerated()), id: \.element.id) { index, thread in
                        if index > 0 {
                            SettingsDivider()
                        }
                        ArchivedThreadRow(thread: thread) {
                            threadManager.unarchiveThread(id: thread.id)
                        }
                    }
                }
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .vCard(background: VColor.surfaceOverlay)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Archived Thread Row

private struct ArchivedThreadRow: View {
    let thread: ThreadModel
    let onUnarchive: () -> Void

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d, yyyy, h:mm a"
        return f
    }()

    var body: some View {
        HStack(alignment: .center, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(thread.title)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Text("\(Self.dateFormatter.string(from: thread.createdAt)) · \(thread.source ?? "vellum-assistant")")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                    .lineLimit(1)
            }

            Spacer()

            VButton(label: "Unarchive", style: .secondary, size: .small) {
                onUnarchive()
            }
        }
        .padding(.vertical, VSpacing.sm)
    }
}

// MARK: - Preview

