import SwiftUI
import VellumAssistantShared

/// Collapsible header for a sidebar conversation group.
///
/// All interaction state is passed via callbacks/bindings -- no direct reference
/// to SidebarInteractionState or ConversationManager. Matches the callback-based
/// API style used by onToggleExpand.
/// Aggregate state of conversations within a collapsed group, shown as an
/// indicator dot on the section header. Priority matches the individual
/// conversation row indicators (highest wins).
enum SectionAggregateState {
    case idle
    case unread
    case processing
    case waitingForInput
    case error
}

struct SidebarSectionHeader: View {
    let group: ConversationGroup
    let conversationCount: Int
    let isExpanded: Bool
    let isDropTarget: Bool
    let isDropForbidden: Bool
    let isGroupReorderTarget: Bool
    let groupDropIndicatorAtBottom: Bool
    let aggregateState: SectionAggregateState
    var onToggleExpand: () -> Void
    var onRename: ((String) -> Void)?
    var onDelete: (() -> Void)?
    var onMarkAllRead: (() -> Void)? = nil
    var hasUnreadConversations: Bool = false
    var onArchiveAll: (() -> Void)? = nil
    var sidebar: SidebarInteractionState?

    @State private var isHeaderHovered: Bool = false

    private var isGroupPinned: Bool {
        group.id == ConversationGroup.pinned.id
    }

    /// Icon to show when the header is NOT hovered. System groups get distinctive icons;
    /// custom groups keep the folder open/closed behaviour.
    private var groupIcon: VIcon {
        if group.id == ConversationGroup.pinned.id {
            return .pin
        } else if group.id == ConversationGroup.scheduled.id {
            return .calendar
        } else if group.id == ConversationGroup.background.id {
            return .layers
        } else if group.id == ConversationGroup.all.id {
            return .clock
        } else {
            return isExpanded ? .folderOpen : .folderClosed
        }
    }

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(isHeaderHovered ? .chevronRight : groupIcon, size: isHeaderHovered ? SidebarLayoutMetrics.sectionChevronSize : 13)
                .foregroundStyle(VColor.contentTertiary)
                .rotationEffect(.degrees(isHeaderHovered && isExpanded ? 90 : (isGroupPinned && !isHeaderHovered ? -45 : 0)))
                .animation(VAnimation.fast, value: isExpanded)
                .animation(VAnimation.fast, value: isHeaderHovered)
                .frame(width: SidebarLayoutMetrics.iconSlotSize, height: SidebarLayoutMetrics.iconSlotSize)

            Text(group.name)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)

            Spacer()
            if !isExpanded {
                switch aggregateState {
                case .error:
                    VIconView(.circleAlert, size: 10)
                        .foregroundStyle(VColor.systemNegativeStrong)
                        .transition(.opacity)
                case .waitingForInput:
                    VIconView(.circleAlert, size: 10)
                        .foregroundStyle(VColor.systemMidStrong)
                        .transition(.opacity)
                case .processing:
                    VBusyIndicator(size: 6)
                        .transition(.opacity)
                case .unread:
                    VBadge(style: .dot, color: VColor.systemMidStrong)
                        .transition(.opacity)
                case .idle:
                    EmptyView()
                }
            }
        }
        .padding(.leading, VSpacing.xs)
        .padding(.trailing, SidebarLayoutMetrics.trailingIconPadding)
        .padding(.vertical, SidebarLayoutMetrics.rowVerticalPadding)
        .frame(minHeight: SidebarLayoutMetrics.rowMinHeight)
        .contentShape(Rectangle())
        .overlay(alignment: .trailing) {
            if conversationCount > 0 {
                Text("\(conversationCount)")
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
                    .padding(.horizontal, VSpacing.sm - VSpacing.xxs)
                    .padding(.vertical, VSpacing.xxs)
                    .background(
                        Capsule()
                            .fill(VColor.contentTertiary.opacity(0.12))
                    )
                    .padding(.trailing, VSpacing.xs)
            }
        }
        .onTapGesture {
            onToggleExpand()
        }
        .pointerCursor(onHover: { hovering in
            isHeaderHovered = hovering
        })
        .background(
            isDropForbidden ? VColor.systemNegativeWeak :
            isDropTarget && !isGroupReorderTarget ? VColor.systemPositiveWeak : .clear
        )
        .cornerRadius(4)
        .overlay(alignment: groupDropIndicatorAtBottom ? .bottom : .top) {
            if isGroupReorderTarget {
                Rectangle()
                    .fill(VColor.systemPositiveStrong)
                    .frame(height: 2)
                    .transition(.opacity)
            }
        }
        .modifier(ConditionalGroupContextMenu(
            onRename: onRename.map { rename in { rename(group.name) } },
            onDelete: onDelete,
            onMarkAllRead: onMarkAllRead,
            hasUnreadConversations: hasUnreadConversations,
            onArchiveAll: onArchiveAll,
            hasConversations: conversationCount > 0
        ))
        .conditionalOnDrag(enabled: !group.isSystemGroup) {
            sidebar?.draggingGroupId = group.id
            return NSItemProvider(object: "group:\(group.id)" as NSString)
        }
    }
}

// MARK: - Conditional context menu modifier

/// Only attaches a `.vContextMenu` when at least one action is available.
/// System groups (where onRename and onDelete are both nil) get no context menu
/// unless onArchiveAll is provided.
private struct ConditionalGroupContextMenu: ViewModifier {
    let onRename: (() -> Void)?
    let onDelete: (() -> Void)?
    let onMarkAllRead: (() -> Void)?
    let hasUnreadConversations: Bool
    let onArchiveAll: (() -> Void)?
    let hasConversations: Bool

    private var hasAnyAction: Bool {
        onRename != nil || onDelete != nil || onMarkAllRead != nil || onArchiveAll != nil
    }

    /// Whether at least one menu item would be enabled. Prevents attaching
    /// a context menu where every item is disabled, which leaves an
    /// undismissable panel (clicking a disabled VMenuItem does not close it).
    private var hasAnyEnabledAction: Bool {
        if onRename != nil || onDelete != nil { return true }
        if onMarkAllRead != nil && hasUnreadConversations { return true }
        if onArchiveAll != nil && hasConversations { return true }
        return false
    }

    func body(content: Content) -> some View {
        if hasAnyAction && hasAnyEnabledAction {
            content.vContextMenu {
                if let onMarkAllRead {
                    VMenuItem(icon: VIcon.circleCheck.rawValue, label: "Mark All as Read") {
                        onMarkAllRead()
                    }
                    .disabled(!hasUnreadConversations)
                }
                if let onArchiveAll {
                    VMenuItem(icon: VIcon.archive.rawValue, label: "Archive All\u{2026}") {
                        onArchiveAll()
                    }
                    .disabled(!hasConversations)
                }
                if (onMarkAllRead != nil || onArchiveAll != nil) && (onRename != nil || onDelete != nil) {
                    VMenuDivider()
                }
                if let onRename {
                    VMenuItem(icon: VIcon.pencil.rawValue, label: "Rename") { onRename() }
                }
                if let onDelete {
                    VMenuItem(icon: VIcon.trash.rawValue, label: hasConversations ? "Delete group\u{2026}" : "Delete group") { onDelete() }
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
