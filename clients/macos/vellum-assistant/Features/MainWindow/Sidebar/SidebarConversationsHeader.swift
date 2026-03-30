import SwiftUI
import VellumAssistantShared

struct SidebarConversationsHeader: View {
    let hasUnseenConversations: Bool
    var isLoading: Bool = false
    let onMarkAllSeen: () -> Void
    let onNewConversation: () -> Void
    var onCreateGroup: (() -> Void)? = nil

    @AppStorage("newChatShortcut") private var newChatShortcut: String = "cmd+n"

    private var newChatTooltip: String {
        let label = "New conversation"
        guard !newChatShortcut.isEmpty else { return label }
        let display = ShortcutHelper.displayString(for: newChatShortcut)
        return "\(label) (\(display))"
    }

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            Text("Conversations")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(VColor.contentDefault)
            Spacer()
            HStack(spacing: VSpacing.xs) {
                if hasUnseenConversations {
                    VButton(
                        label: "Mark all as seen",
                        iconOnly: VIcon.circleCheck.rawValue,
                        style: .ghost,
                        action: onMarkAllSeen
                    )
                    .disabled(isLoading)
                    .vTooltip("Mark all as seen")
                }
                if let onCreateGroup {
                    VButton(
                        label: "New group",
                        iconOnly: VIcon.folderPlus.rawValue,
                        style: .ghost,
                        action: onCreateGroup
                    )
                    .vTooltip("New group")
                }
                VButton(label: "New conversation", iconOnly: VIcon.squarePen.rawValue, style: .ghost, action: onNewConversation)
                    .disabled(isLoading)
                    .opacity(isLoading ? 0.4 : 1)
                    .vTooltip(newChatTooltip)
            }
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
            .disabled(!hasUnseenConversations)
        }
    }
}
