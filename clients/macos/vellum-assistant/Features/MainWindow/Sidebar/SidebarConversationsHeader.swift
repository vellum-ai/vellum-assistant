import SwiftUI
import VellumAssistantShared

struct SidebarConversationsHeader: View, Equatable {
    let hasUnseenConversations: Bool
    var isLoading: Bool = false
    let onMarkAllSeen: () -> Void
    let onNewConversation: () -> Void
    var onCreateGroup: (() -> Void)? = nil

    @AppStorage("newChatShortcut") private var newChatShortcut: String = "cmd+n"

    /// Closures are assumed stable across renders — only compare the value
    /// props that actually drive rendering. Lets `.equatable()` short-circuit
    /// body evaluation when parent invalidates without relevant changes.
    static func == (lhs: SidebarConversationsHeader, rhs: SidebarConversationsHeader) -> Bool {
        lhs.hasUnseenConversations == rhs.hasUnseenConversations
            && lhs.isLoading == rhs.isLoading
            && (lhs.onCreateGroup == nil) == (rhs.onCreateGroup == nil)
    }

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
                        label: "Mark all as read",
                        iconOnly: VIcon.circleCheck.rawValue,
                        style: .ghost,
                        action: onMarkAllSeen
                    )
                    .disabled(isLoading)
                    .vTooltip("Mark all as read")
                }
                if let onCreateGroup {
                    VButton(
                        label: "New group",
                        iconOnly: VIcon.folderPlus.rawValue,
                        style: .ghost,
                        action: onCreateGroup
                    )
                    .disabled(isLoading)
                    .vTooltip("New group")
                }
                VButton(label: "New conversation", iconOnly: VIcon.squarePen.rawValue, style: .ghost, action: onNewConversation)
                    .disabled(isLoading)
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
                Label { Text("Mark All as Read") } icon: { VIconView(.circleCheck, size: 14) }
            }
            .disabled(!hasUnseenConversations)
        }
    }
}
