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
    let isGroupReorderTarget: Bool
    let groupDropIndicatorAtBottom: Bool
    let aggregateState: SectionAggregateState
    let isRenaming: Bool                       // M5: inline rename active
    @Binding var renamingName: String           // M5: bound to rename text field
    var onToggleExpand: () -> Void
    var onRename: ((String) -> Void)?
    var onCommitRename: ((String) -> Void)?
    var onCancelRename: (() -> Void)?
    var onDelete: (() -> Void)?
    var sidebar: SidebarInteractionState?

    @FocusState private var isRenameFocused: Bool
    @State private var isHeaderHovered: Bool = false

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(isHeaderHovered ? .chevronRight : (isExpanded ? .folderOpen : .folderClosed), size: isHeaderHovered ? SidebarLayoutMetrics.sectionChevronSize : 13)
                .foregroundStyle(VColor.contentTertiary)
                .rotationEffect(.degrees(isHeaderHovered && isExpanded ? 90 : 0))
                .animation(VAnimation.fast, value: isExpanded)
                .animation(VAnimation.fast, value: isHeaderHovered)
                .frame(width: SidebarLayoutMetrics.iconSlotSize, height: SidebarLayoutMetrics.iconSlotSize)

            if isRenaming {
                TextField("Group name", text: $renamingName, onCommit: {
                    onCommitRename?(renamingName)
                })
                .font(VFont.menuCompact)
                .textFieldStyle(.plain)
                .focused($isRenameFocused)
                .onAppear { isRenameFocused = true }
                .onExitCommand {
                    // Cancel rename on Escape — discard edits without API call
                    onCancelRename?()
                }
            } else {
                Text(group.name)
                    .font(VFont.menuCompact)
                    .foregroundStyle(VColor.contentSecondary)
            }

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
                if conversationCount > 0 {
                    Text("\(conversationCount)")
                        .font(.caption2)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }
        }
        .padding(.leading, VSpacing.xs)
        .padding(.trailing, VSpacing.sm)
        .padding(.vertical, SidebarLayoutMetrics.rowVerticalPadding)
        .frame(minHeight: SidebarLayoutMetrics.rowMinHeight)
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(VAnimation.fast) { onToggleExpand() } }
        .pointerCursor(onHover: { hovering in
            isHeaderHovered = hovering
        })
        .background(isDropTarget && !isGroupReorderTarget ? VColor.systemPositiveWeak : .clear)
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
            onDelete: onDelete
        ))
        .conditionalOnDrag(enabled: !group.isSystemGroup) {
            sidebar?.draggingGroupId = group.id
            return NSItemProvider(object: "group:\(group.id)" as NSString)
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
                    VMenuItem(icon: VIcon.pencil.rawValue, label: "Rename") { onRename() }
                }
                if let onDelete {
                    VMenuItem(icon: VIcon.trash.rawValue, label: "Delete") { onDelete() }
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
