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
    var onCancelRename: (() -> Void)?           // M5: cancels rename without persisting (Escape key)
    var onDelete: (() -> Void)?                 // M5: nil for system groups

    @FocusState private var isRenameFocused: Bool

    var body: some View {
        HStack(spacing: SidebarLayoutMetrics.listRowGap) {
            VIconView(.chevronRight, size: SidebarLayoutMetrics.sectionChevronSize)
                .foregroundStyle(VColor.contentTertiary)
                .rotationEffect(.degrees(isExpanded ? 90 : 0))
                .animation(VAnimation.fast, value: isExpanded)

            if isRenaming {
                TextField("Group name", text: $renamingName, onCommit: {
                    onCommitRename?(renamingName)
                })
                .font(.caption)
                .textFieldStyle(.plain)
                .focused($isRenameFocused)
                .onAppear { isRenameFocused = true }
                .onExitCommand {
                    // Cancel rename on Escape — discard edits without API call
                    onCancelRename?()
                }
            } else {
                Text(group.name)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

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
        .modifier(ConditionalGroupContextMenu(
            onRename: onRename.map { rename in { rename(group.name) } },
            onDelete: onDelete
        ))
        .conditionalOnDrag(enabled: !group.isSystemGroup) {
            NSItemProvider(object: "group:\(group.id)" as NSString)
        }
    }
}

// MARK: - Conditional context menu modifier

/// Only attaches a `.vContextMenu` when at least one action is available.
/// System groups (where onRename and onDelete are both nil) get no context menu.
private struct ConditionalGroupContextMenu: ViewModifier {
    let onRename: (() -> Void)?
    let onDelete: (() -> Void)?

    func body(content: Content) -> some View {
        if onRename != nil || onDelete != nil {
            content.vContextMenu {
                if let onRename {
                    Button("Rename") { onRename() }
                }
                if let onDelete {
                    Button("Delete") { onDelete() }
                }
            }
        } else {
            content
        }
    }
}

// MARK: - Conditional onDrag modifier

private extension View {
    /// Applies .onDrag only when `enabled` is true. System groups are not draggable.
    @ViewBuilder
    func conditionalOnDrag(enabled: Bool, data: @escaping () -> NSItemProvider) -> some View {
        if enabled {
            self.onDrag(data)
        } else {
            self
        }
    }
}
