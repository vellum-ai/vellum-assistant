import SwiftUI
import VellumAssistantShared

/// A schedule sub-group: conversations sharing the same scheduleJobId.
struct ScheduleSubGroup: Identifiable {
    let key: String
    let label: String
    let conversations: [ConversationModel]
    var id: String { key }
}

/// Container wrapping a collapsible section header + conversation list.
///
/// Handles expand/collapse, show-more/less truncation, auto-expand on unread,
/// and optional schedule sub-grouping for the Scheduled system group.
struct SidebarSectionView: View {
    let group: ConversationGroup?
    let conversations: [ConversationModel]
    let isExpanded: Bool
    let showAll: Bool
    let maxCollapsed: Int
    let isDropTarget: Bool
    let countMode: CountMode

    let isRenaming: Bool
    @Binding var renamingName: String
    var onRename: ((String) -> Void)?
    var onCommitRename: ((String) -> Void)?
    var onCancelRename: (() -> Void)?
    var onDelete: (() -> Void)?

    /// The currently selected conversation ID. Passed through so that SwiftUI
    /// re-evaluates this view's body (and thus re-calls makeRow) when selection changes.
    let selectedConversationId: UUID?

    var onToggleExpand: () -> Void
    var onToggleShowAll: () -> Void
    var makeRow: (ConversationModel) -> SidebarConversationItem

    /// Schedule sub-group expand/collapse state.
    var expandedScheduleGroups: Binding<Set<String>>?
    /// Optional label provider for sub-groups. When set, overrides the default
    /// title-parsing logic in `buildSubGroups`. Receives the group key and its
    /// conversations, returns the display label.
    var subGroupLabelProvider: ((String, [ConversationModel]) -> String)?
    /// Drop delegate plumbing.
    var sidebar: SidebarInteractionState?
    var conversationManager: ConversationManager?

    /// Tracks which sub-groups have been toggled to show all conversations
    /// (mirrors showAll at the section level but per sub-group key).
    @State private var showAllInSubGroup: Set<String> = []

    enum CountMode {
        case items
        case subGroups(grouper: (ConversationModel) -> String?)
    }

    /// Whether the section is manually expanded to show all items.
    /// The collapsed section header already shows an unread indicator dot,
    /// so we no longer auto-expand for unread messages.
    private var effectiveShowAll: Bool { showAll }

    private var unreadCount: Int {
        conversations.filter(\.hasUnseenLatestAssistantMessage).count
    }

    /// Highest-priority interaction state across all conversations in this section.
    /// Guarded by `isExpanded` to skip the iteration when the indicator isn't visible.
    private var aggregateState: SectionAggregateState {
        if isExpanded { return .idle }
        guard let conversationManager else {
            return unreadCount > 0 ? .unread : .idle
        }
        var hasProcessing = false
        var hasWaitingForInput = false
        var hasUnread = false
        for conversation in conversations {
            switch conversationManager.interactionState(for: conversation.id) {
            case .error:
                return .error
            case .waitingForInput:
                hasWaitingForInput = true
            case .processing:
                hasProcessing = true
            case .idle:
                break
            }
            if conversation.hasUnseenLatestAssistantMessage {
                hasUnread = true
            }
        }
        if hasWaitingForInput { return .waitingForInput }
        if hasProcessing { return .processing }
        if hasUnread { return .unread }
        return .idle
    }

    private var displayCount: Int {
        return conversations.count
    }

    var body: some View {
        if let group = group {
            SidebarSectionHeader(
                group: group,
                conversationCount: displayCount,
                isExpanded: isExpanded,
                isDropTarget: isDropTarget,
                isGroupReorderTarget: !group.isSystemGroup && sidebar?.dropTargetSectionId == group.id && sidebar?.draggingConversationId == nil,
                groupDropIndicatorAtBottom: sidebar?.groupDropIndicatorAtBottom ?? false,
                aggregateState: aggregateState,
                isRenaming: isRenaming,
                renamingName: $renamingName,
                onToggleExpand: onToggleExpand,
                onRename: onRename,
                onCommitRename: onCommitRename,
                onCancelRename: onCancelRename,
                onDelete: onDelete,
                sidebar: sidebar
            )
            .modifier(SectionHeaderDropModifier(
                group: group,
                sidebar: sidebar,
                conversationManager: conversationManager
            ))

            if isExpanded && !conversations.isEmpty {
                VStack(spacing: 0) {
                    sectionContent
                }
                .padding(.bottom, VSpacing.xxs)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(isDropTarget ? VColor.systemPositiveWeak : .clear)
                )
                .modifier(SectionBodyDropModifier(
                    groupId: group.id,
                    sidebar: sidebar,
                    conversationManager: conversationManager
                ))
                .transition(.opacity)
            }
        } else {
            // Ungrouped -- no header, render conversations directly
            sectionContent
        }
    }

    @ViewBuilder
    private var sectionContent: some View {
        switch countMode {
        case .subGroups(let grouper):
            scheduleSubGroupContent(grouper: grouper)
        case .items:
            flatContent
        }
    }

    @ViewBuilder
    private var flatContent: some View {
        let displayed = displayedConversations
        if let sidebar, let conversationManager {
            ForEach(displayed) { conversation in
                makeRow(conversation)
                    .equatable()
                    .id(ConversationRowIdentity(conversationId: conversation.id, groupId: conversation.groupId))
                    .padding(.bottom, SidebarLayoutMetrics.listRowGap)
                    .overlay(alignment: sidebar.dropIndicatorAtBottom ? .bottom : .top) {
                        if sidebar.dropTargetConversationId == conversation.id {
                            Rectangle()
                                .fill(VColor.primaryBase)
                                .frame(height: 2)
                                .transition(.opacity)
                        }
                    }
                    .dropDestination(for: String.self) { items, _ in
                        guard let droppedId = items.first,
                              let sourceUUID = UUID(uuidString: droppedId),
                              sourceUUID != conversation.id else {
                            sidebar.endConversationDrag()
                            return false
                        }
                        let insertAfter = sidebar.dropIndicatorAtBottom
                        let moved = conversationManager.moveConversation(sourceId: sourceUUID, targetId: conversation.id, insertAfterTarget: insertAfter)
                        sidebar.endConversationDrag()
                        return moved
                    } isTargeted: { isTargeted in
                        if isTargeted && conversation.id != sidebar.draggingConversationId {
                            sidebar.dropTargetConversationId = conversation.id
                            if let dragId = sidebar.draggingConversationId {
                                let groupConversations = conversationManager.groupedConversations
                                    .first { $0.group?.id == group?.id }?.conversations ?? []
                                let sIdx = groupConversations.firstIndex(where: { $0.id == dragId }) ?? 0
                                let tIdx = groupConversations.firstIndex(where: { $0.id == conversation.id }) ?? 0
                                sidebar.dropIndicatorAtBottom = sIdx < tIdx
                            }
                        } else if !isTargeted && sidebar.dropTargetConversationId == conversation.id {
                            sidebar.dropTargetConversationId = nil
                        }
                    }
            }
        } else {
            ForEach(displayed) { conversation in
                makeRow(conversation)
                    .equatable()
                    .id(ConversationRowIdentity(conversationId: conversation.id, groupId: conversation.groupId))
                    .padding(.bottom, SidebarLayoutMetrics.listRowGap)
            }
        }

        showMoreLessButton

        // When all loaded conversations fit within maxCollapsed (e.g. pinned
        // sections use .max) the show-more button never appears, yet more
        // conversations may exist on the server beyond the initial page.
        // Auto-trigger a full load so those items become visible.
        if conversations.count <= maxCollapsed,
           let conversationManager,
           conversationManager.hasMoreConversations {
            Color.clear
                .frame(height: 0)
                .onAppear {
                    conversationManager.loadAllRemainingConversations()
                }
        }
    }

    // MARK: - Schedule Sub-Groups

    @ViewBuilder
    private func scheduleSubGroupContent(grouper: (ConversationModel) -> String?) -> some View {
        let subGroups = buildSubGroups(grouper: grouper)
        let displayed = effectiveShowAll ? subGroups : Array(subGroups.prefix(maxCollapsed))

        ForEach(displayed) { subGroup in
            if subGroup.conversations.count == 1, let conversation = subGroup.conversations.first {
                // Single-conversation sub-group: render inline as a regular row
                makeRow(conversation)
                    .equatable()
                    .id(ConversationRowIdentity(conversationId: conversation.id, groupId: conversation.groupId))
                    .padding(.bottom, SidebarLayoutMetrics.listRowGap)
            } else {
                // Multi-conversation sub-group: disclosure header + rows
                scheduleSubGroupDisclosure(subGroup)
            }
        }

        if subGroups.count > maxCollapsed {
            showMoreLessButton
        }
    }

    @ViewBuilder
    private func scheduleSubGroupDisclosure(_ subGroup: ScheduleSubGroup) -> some View {
        let isSubGroupExpanded = expandedScheduleGroups?.wrappedValue.contains(subGroup.key) ?? false
        let hasUnread = subGroup.conversations.contains(where: \.hasUnseenLatestAssistantMessage)

        // Disclosure header — layout matches SidebarConversationItem's skeleton
        // so the chevron aligns with the pin icon and the badge aligns with the ellipsis.
        Button {
            withAnimation(VAnimation.fast) {
                if isSubGroupExpanded {
                    expandedScheduleGroups?.wrappedValue.remove(subGroup.key)
                } else {
                    expandedScheduleGroups?.wrappedValue.insert(subGroup.key)
                }
            }
        } label: {
            HStack(spacing: VSpacing.xs) {
                // Leading 20x20 slot — chevron centered, matching pin icon position
                VIconView(.chevronRight, size: 10)
                    .foregroundStyle(VColor.contentTertiary)
                    .rotationEffect(.degrees(isSubGroupExpanded ? 90 : 0))
                    .animation(VAnimation.fast, value: isSubGroupExpanded)
                    .frame(width: 20, height: 20)

                Text(subGroup.label)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer()
                if hasUnread {
                    VBadge(style: .dot, color: VColor.systemMidStrong)
                        .transition(.opacity)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, VSpacing.xs)
            .padding(.trailing, SidebarLayoutMetrics.trailingIconPadding)
            .padding(.vertical, SidebarLayoutMetrics.rowVerticalPadding)
            .frame(minHeight: SidebarLayoutMetrics.rowMinHeight)
            .contentShape(Rectangle())
            // Count badge — trailing overlay matching ellipsis button position
            .overlay(alignment: .trailing) {
                Text("\(subGroup.conversations.count)")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(VColor.contentTertiary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        Capsule()
                            .fill(VColor.contentTertiary.opacity(0.12))
                    )
                    .padding(.trailing, VSpacing.xs)
            }
        }
        .buttonStyle(.plain)
        .pointerCursor()

        if isSubGroupExpanded {
            let subGroupShowAll = showAllInSubGroup.contains(subGroup.key)
            let displayedInSubGroup = subGroupShowAll
                ? subGroup.conversations
                : Array(subGroup.conversations.prefix(maxCollapsed))

            VStack(spacing: 0) {
                ForEach(displayedInSubGroup) { conversation in
                    makeRow(conversation)
                        .equatable()
                        .id(ConversationRowIdentity(conversationId: conversation.id, groupId: conversation.groupId))
                        .padding(.bottom, SidebarLayoutMetrics.listRowGap)
                }

                if subGroup.conversations.count > maxCollapsed {
                    HStack {
                        VButton(
                            label: subGroupShowAll ? "Show less" : "Show more",
                            style: .ghost,
                            size: .compact
                        ) {
                            withAnimation(VAnimation.fast) {
                                if subGroupShowAll {
                                    showAllInSubGroup.remove(subGroup.key)
                                } else {
                                    showAllInSubGroup.insert(subGroup.key)
                                }
                            }
                        }
                        Spacer()
                    }
                    .padding(.leading, VSpacing.xs + SidebarLayoutMetrics.iconSlotSize + VSpacing.xs - VSpacing.sm)
                    .padding(.bottom, VSpacing.xs)
                }
            }
            .padding(.vertical, VSpacing.xxs)
            .overlay(alignment: .leading) {
                UnevenRoundedRectangle(
                    topLeadingRadius: VRadius.md,
                    bottomLeadingRadius: VRadius.md
                )
                .fill(VColor.contentTertiary.opacity(0.12))
                .frame(width: 2)
            }
        }
    }

    // MARK: - Show More/Less

    @ViewBuilder
    private var showMoreLessButton: some View {
        if conversations.count > maxCollapsed {
            HStack {
                VButton(
                    label: showAll ? "Show less" : "Show more",
                    style: .ghost,
                    size: .compact
                ) {
                    withAnimation(VAnimation.fast) { onToggleShowAll() }
                    if !showAll {
                        conversationManager?.loadAllRemainingConversations()
                    }
                }
                Spacer()
            }
            .padding(.leading, VSpacing.xs + SidebarLayoutMetrics.iconSlotSize + VSpacing.xs - VSpacing.sm)
            .padding(.bottom, VSpacing.xs)
        }
    }

    private var displayedConversations: [ConversationModel] {
        if effectiveShowAll { return conversations }
        return Array(conversations.prefix(maxCollapsed))
    }

    // MARK: - Sub-group helpers

    private func buildSubGroups(grouper: (ConversationModel) -> String?) -> [ScheduleSubGroup] {
        var grouped: [String: [ConversationModel]] = [:]
        var order: [String] = []
        for conversation in conversations {
            let key = grouper(conversation) ?? conversation.id.uuidString
            if grouped[key] == nil {
                order.append(key)
            }
            grouped[key, default: []].append(conversation)
        }
        return order.compactMap { key in
            guard let conversations = grouped[key], let first = conversations.first else { return nil }
            let label: String
            if let provider = subGroupLabelProvider {
                label = provider(key, conversations)
            } else if conversations.count > 1 {
                let base = first.title
                if let colonRange = base.range(of: ":") {
                    label = String(base[base.startIndex..<colonRange.lowerBound])
                } else {
                    label = base
                }
            } else {
                label = first.title
            }
            return ScheduleSubGroup(key: key, label: label, conversations: conversations)
        }
    }
}

/// ViewModifier that conditionally attaches a SidebarSectionHeaderDropDelegate
/// to a section header when sidebar and conversationManager are available.
struct SectionHeaderDropModifier: ViewModifier {
    let group: ConversationGroup
    let sidebar: SidebarInteractionState?
    let conversationManager: ConversationManager?

    func body(content: Content) -> some View {
        if let sidebar, let conversationManager {
            content.onDrop(of: [.plainText], delegate: SidebarSectionHeaderDropDelegate(
                groupId: group.id,
                group: group,
                sidebar: sidebar,
                conversationManager: conversationManager
            ))
        } else {
            content
        }
    }
}

/// ViewModifier that conditionally attaches a conversation-group drop target to
/// an expanded section body so drops work reliably in whitespace between rows.
struct SectionBodyDropModifier: ViewModifier {
    let groupId: String
    let sidebar: SidebarInteractionState?
    let conversationManager: ConversationManager?

    func body(content: Content) -> some View {
        if let sidebar, let conversationManager {
            content.onDrop(of: [.plainText], delegate: SidebarSectionBodyDropDelegate(
                groupId: groupId,
                sidebar: sidebar,
                conversationManager: conversationManager
            ))
        } else {
            content
        }
    }
}

/// Drop delegate for an expanded section body (not header, not row target).
struct SidebarSectionBodyDropDelegate: DropDelegate {
    let groupId: String
    let sidebar: SidebarInteractionState
    let conversationManager: ConversationManager

    func validateDrop(info: DropInfo) -> Bool {
        guard let sourceId = sidebar.draggingConversationId,
              let source = conversationManager.conversations.first(where: { $0.id == sourceId }),
              source.groupId != groupId
        else { return false }
        return true
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: .move)
    }

    func dropEntered(info: DropInfo) {
        sidebar.dropTargetSectionId = groupId
    }

    func dropExited(info: DropInfo) {
        if sidebar.dropTargetSectionId == groupId {
            sidebar.dropTargetSectionId = nil
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        let sourceId = sidebar.draggingConversationId
        sidebar.endConversationDrag()
        guard let sourceId else { return false }
        conversationManager.moveConversationToGroup(sourceId, groupId: groupId)
        return true
    }
}
