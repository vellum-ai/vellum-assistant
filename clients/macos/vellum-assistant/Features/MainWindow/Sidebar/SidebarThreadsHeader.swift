import SwiftUI
import VellumAssistantShared

struct SidebarThreadsHeader: View {
    let hasUnseenThreads: Bool
    var isLoading: Bool = false
    let onMarkAllSeen: () -> Void
    let onNewThread: () -> Void

    var body: some View {
        HStack {
            Text("Threads")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(VColor.textPrimary)
            Spacer()
            if hasUnseenThreads {
                VIconButton(
                    label: "Mark all as seen",
                    icon: "checkmark.circle",
                    iconOnly: true,
                    tooltip: "Mark all as seen",
                    action: onMarkAllSeen
                )
                .disabled(isLoading)
            }
            VIconButton(label: "New thread", icon: "plus", iconOnly: true, action: onNewThread)
                .disabled(isLoading)
                .opacity(isLoading ? 0.4 : 1)
        }
        .padding(.leading, 20)
        .padding(.trailing, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .contextMenu {
            Button {
                onMarkAllSeen()
            } label: {
                Label("Mark All as Seen", systemImage: "checkmark.circle")
            }
            .disabled(!hasUnseenThreads)
        }
    }
}
