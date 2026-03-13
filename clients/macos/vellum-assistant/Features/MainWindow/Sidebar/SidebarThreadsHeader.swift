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
                VIconButton(
                    label: "Mark all as seen",
                    icon: VIcon.circleCheck.rawValue,
                    iconOnly: true,
                    tooltip: "Mark all as seen",
                    action: onMarkAllSeen
                )
                .disabled(isLoading)
            }
            VIconButton(label: "New thread", icon: VIcon.squarePen.rawValue, iconOnly: true, action: onNewThread)
                .disabled(isLoading)
                .opacity(isLoading ? 0.4 : 1)
        }
        .padding(.leading, SidebarLayoutMetrics.iconSlotSize)
        .padding(.trailing, VSpacing.md)
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
