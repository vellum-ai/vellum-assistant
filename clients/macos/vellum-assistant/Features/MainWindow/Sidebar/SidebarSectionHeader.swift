import SwiftUI
import VellumAssistantShared

/// Collapsible header for a sidebar conversation group.
///
/// All interaction state is passed via callbacks/bindings -- no direct reference
/// to SidebarInteractionState or ConversationManager. Matches the callback-based
/// API style used by onToggleExpand.
struct SidebarSectionHeader: View {
    let group: ConversationGroup
    let conversationCount: Int
    let isExpanded: Bool
    let isDropTarget: Bool
    let unreadCount: Int
    let isRenaming: Bool                       // M5: inline rename active
    @Binding var renamingName: String           // M5: bound to rename text field
    var onToggleExpand: () -> Void
    var onRename: ((String) -> Void)?           // M5: enters rename mode (nil for system groups)
    var onCommitRename: ((String) -> Void)?     // M5: commits the rename (nil for system groups)
    var onDelete: (() -> Void)?                 // M5: nil for system groups

    var body: some View {
        HStack(spacing: SidebarLayoutMetrics.listRowGap) {
            VIconView(.chevronRight, size: SidebarLayoutMetrics.sectionChevronSize)
                .foregroundStyle(VColor.contentTertiary)
                .rotationEffect(.degrees(isExpanded ? 90 : 0))
                .animation(VAnimation.fast, value: isExpanded)
            Text(group.name)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            if !isExpanded {
                if unreadCount > 0 {
                    Circle()
                        .fill(VColor.systemNegativeStrong)
                        .frame(width: 6, height: 6)
                        .transition(.opacity)
                }
                if conversationCount > 0 {
                    Text("\(conversationCount)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.top, SidebarLayoutMetrics.sectionTitleTopGap)
        .padding(.bottom, SidebarLayoutMetrics.sectionTitleBottomGap)
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(VAnimation.fast) { onToggleExpand() } }
        .background(isDropTarget ? Color.accentColor.opacity(0.15) : .clear)
        .cornerRadius(4)
    }
}
