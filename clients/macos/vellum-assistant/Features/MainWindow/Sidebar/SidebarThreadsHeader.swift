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
                .foregroundColor(VColor.contentDefault)
            Spacer()
            if hasUnseenThreads {
                VButton(
                    label: "Mark all as seen",
                    iconOnly: VIcon.circleCheck.rawValue,
                    style: .ghost,
                    tooltip: "Mark all as seen",
                    action: onMarkAllSeen
                )
                .disabled(isLoading)
            }
            VButton(label: "New thread", iconOnly: VIcon.squarePen.rawValue, style: .ghost, action: onNewThread)
                .disabled(isLoading)
                .opacity(isLoading ? 0.4 : 1)
        }
        .padding(.leading, 0)
        .padding(.trailing, 0)
        .padding(.top, SidebarLayoutMetrics.sectionTitleTopGap)
        .contextMenu {
            Button {
                onMarkAllSeen()
            } label: {
                Label { Text("Mark All as Seen") } icon: { VIconView(.circleCheck, size: 14) }
            }
            .disabled(!hasUnseenThreads)
        }
    }
}
