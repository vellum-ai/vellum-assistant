import VellumAssistantShared
import SwiftUI

struct AssistantInboxPanel: View {
    var onClose: () -> Void
    @StateObject private var viewModel: InboxViewModel

    init(onClose: @escaping () -> Void, daemonClient: DaemonClient) {
        self.onClose = onClose
        self._viewModel = StateObject(wrappedValue: InboxViewModel(daemonClient: daemonClient))
    }

    var body: some View {
        VSidePanel(title: "Inbox", onClose: onClose) {
            if viewModel.isLoading {
                VStack {
                    Spacer()
                    VLoadingIndicator()
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = viewModel.error {
                VEmptyState(
                    title: "Failed to load",
                    subtitle: error,
                    icon: "exclamationmark.triangle.fill"
                )
            } else if viewModel.threads.isEmpty {
                VEmptyState(
                    title: "No messages",
                    subtitle: "Messages from your assistant will appear here",
                    icon: "tray.fill"
                )
            } else {
                threadListView
            }
        }
        .task {
            await viewModel.loadThreads()
        }
    }

    private var threadListView: some View {
        VStack(spacing: 0) {
            ForEach(viewModel.threads) { thread in
                VListRow {
                    InboxThreadRow(thread: thread)
                }
                if thread.id != viewModel.threads.last?.id {
                    Divider()
                        .background(VColor.surfaceBorder)
                        .padding(.horizontal, VSpacing.sm)
                }
            }
        }
    }
}

private struct InboxThreadRow: View {
    let thread: InboxThread

    var body: some View {
        HStack(spacing: VSpacing.md) {
            // Channel icon
            Image(systemName: thread.channelIcon)
                .font(VFont.body)
                .foregroundColor(VColor.accent)
                .frame(width: 24, alignment: .center)
                .accessibilityLabel(thread.sourceChannel)

            // Name and timestamp
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                HStack {
                    Text(thread.resolvedName)
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.textPrimary)
                        .lineLimit(1)

                    Spacer()

                    if let lastMessageAt = thread.lastMessageAt {
                        Text(relativeTimestamp(lastMessageAt))
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                }

                HStack {
                    if thread.hasPendingEscalation {
                        Text("Needs attention")
                            .font(VFont.caption)
                            .foregroundColor(VColor.warning)
                    } else {
                        Text(thread.sourceChannel.capitalized)
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                    }

                    Spacer()

                    if thread.unreadCount > 0 {
                        VBadge(style: .count(thread.unreadCount))
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(thread.resolvedName), \(thread.sourceChannel), \(thread.unreadCount) unread")
    }

    private func relativeTimestamp(_ date: Date) -> String {
        let now = Date()
        let interval = now.timeIntervalSince(date)

        if interval < 60 {
            return "now"
        } else if interval < 3600 {
            let minutes = Int(interval / 60)
            return "\(minutes)m"
        } else if interval < 86400 {
            let hours = Int(interval / 3600)
            return "\(hours)h"
        } else if interval < 604800 {
            let days = Int(interval / 86400)
            return "\(days)d"
        } else {
            let formatter = DateFormatter()
            formatter.dateFormat = "MMM d"
            return formatter.string(from: date)
        }
    }
}

#if DEBUG
struct AssistantInboxPanel_Preview: PreviewProvider {
    static var previews: some View {
        AssistantInboxPanelPreviewWrapper()
            .frame(width: 350, height: 500)
            .previewDisplayName("AssistantInboxPanel")
    }
}

private struct AssistantInboxPanelPreviewWrapper: View {
    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            // Show the empty-state version for previews since we can't connect to a daemon
            VSidePanel(title: "Inbox", onClose: {}) {
                VEmptyState(
                    title: "No messages",
                    subtitle: "Messages from your assistant will appear here",
                    icon: "tray.fill"
                )
            }
        }
    }
}
#endif
