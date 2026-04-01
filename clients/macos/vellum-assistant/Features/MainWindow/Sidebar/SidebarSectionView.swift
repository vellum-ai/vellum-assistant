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
    /// Drop delegate plumbing.
    var sidebar: SidebarInteractionState?
    var conversationManager: ConversationManager?

    enum CountMode {
        case items
        case subGroups(grouper: (ConversationModel) -> String?)
    }

    /// Auto-show-all when hidden items beyond the truncation cutoff have unread messages.
    private var effectiveShowAll: Bool {
        if showAll { return true }
        switch countMode {
        case .items:
            let hidden = conversations.dropFirst(maxCollapsed)
            return hidden.contains(where: \.hasUnseenLatestAssistantMessage)
        case .subGroups(let grouper):
            let subGroups = buildSubGroups(grouper: grouper)
            let hidden = subGroups.dropFirst(maxCollapsed)
            return hidden.contains(where: { sg in
                sg.conversations.contains(where: \.hasUnseenLatestAssistantMessage)
            })
        }
    }

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

            if isExpanded {
                VStack(spacing: 0) {
                    sectionContent
                }
                .padding(.vertical, VSpacing.xxs)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(isDropTarget ? VColor.systemPositiveWeak : VColor.contentTertiary.opacity(0.06))
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
                    .onDrop(of: [.plainText], delegate: GroupedReorderDropDelegate(
                        targetConversation: conversation,
                        groupId: group?.id,
                        sidebar: sidebar,
                        conversationManager: conversationManager
                    ))
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
        let hasUnread = !isSubGroupExpanded &&
            subGroup.conversations.contains(where: \.hasUnseenLatestAssistantMessage)

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
                ZStack {
                    VIconView(.chevronRight, size: 10)
                        .foregroundStyle(VColor.contentTertiary)
                        .rotationEffect(.degrees(isSubGroupExpanded ? 90 : 0))
                        .animation(VAnimation.fast, value: isSubGroupExpanded)
                    if hasUnread {
                        Circle()
                            .fill(VColor.systemMidStrong)
                            .frame(width: 6, height: 6)
                            .offset(x: 7, y: -7)
                            .transition(.opacity)
                    }
                }
                .frame(width: 20, height: 20)

                Text(subGroup.label)
                    .font(VFont.menuCompact)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer()
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
            VStack(spacing: 0) {
                ForEach(subGroup.conversations) { conversation in
                    makeRow(conversation)
                        .equatable()
                        .id(ConversationRowIdentity(conversationId: conversation.id, groupId: conversation.groupId))
                        .padding(.bottom, SidebarLayoutMetrics.listRowGap)
                }
            }
            .padding(.vertical, VSpacing.xxs)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(VColor.contentTertiary.opacity(0.03))
            )
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
        if conversations.count > maxCollapsed, showAll || !effectiveShowAll {
            HStack {
                VButton(
                    label: showAll ? "Show less" : "Show more",
                    style: .ghost,
                    size: .compact
                ) {
                    withAnimation(VAnimation.fast) { onToggleShowAll() }
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
            if conversations.count > 1 {
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

/// Drop delegate for reordering conversations within a grouped section.
/// Uses section-local index comparison for drop indicator direction.
struct GroupedReorderDropDelegate: DropDelegate {
    let targetConversation: ConversationModel
    let groupId: String?
    let sidebar: SidebarInteractionState
    let conversationManager: ConversationManager

    func validateDrop(info: DropInfo) -> Bool {
        guard let dragId = sidebar.draggingConversationId,
              dragId != targetConversation.id
        else { return false }
        return true
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        return DropProposal(operation: .move)
    }

    func dropEntered(info: DropInfo) {
        guard let dragId = sidebar.draggingConversationId,
              dragId != targetConversation.id
        else { return }

        sidebar.dropTargetConversationId = targetConversation.id
        let groupConversations = conversationManager.groupedConversations
            .first { $0.group?.id == groupId }?.conversations ?? []
        let sIdx = groupConversations.firstIndex(where: { $0.id == dragId })
        let tIdx = groupConversations.firstIndex(where: { $0.id == targetConversation.id }) ?? 0
        if let sIdx {
            sidebar.dropIndicatorAtBottom = sIdx < tIdx
        } else {
            sidebar.dropIndicatorAtBottom = false
        }
    }

    func dropExited(info: DropInfo) {
        if sidebar.dropTargetConversationId == targetConversation.id {
            sidebar.dropTargetConversationId = nil
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        let sourceId = sidebar.draggingConversationId
        let insertAfter = sidebar.dropIndicatorAtBottom
        sidebar.dropTargetConversationId = nil
        sidebar.endConversationDrag()
        guard let sourceId = sourceId, sourceId != targetConversation.id else { return false }
        return conversationManager.moveConversation(sourceId: sourceId, targetId: targetConversation.id, insertAfterTarget: insertAfter)
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
