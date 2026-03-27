import SwiftUI
import VellumAssistantShared

/// A schedule sub-group: conversations sharing the same scheduleJobId.
struct ScheduleSubGroup {
    let key: String
    let label: String
    let conversations: [ConversationModel]
}

/// Container wrapping a collapsible section header + conversation list.
///
/// Handles expand/collapse, show-more/less truncation, auto-expand on unread,
/// and schedule sub-grouping (clusters by scheduleJobId when countMode is .subGroups).
struct SidebarSectionView: View {
    let group: ConversationGroup?
    let conversations: [ConversationModel]
    let isExpanded: Bool
    let showAll: Bool
    let maxCollapsed: Int
    let isDropTarget: Bool
    let countMode: CountMode

    // Rename/delete plumbing -- passed through to SidebarSectionHeader.
    // M3 passes inert defaults (isRenaming: false, renamingName: .constant(""),
    // onRename: nil, onCommitRename: nil, onDelete: nil).
    // M5 wires these to ConversationManager/SidebarInteractionState.
    let isRenaming: Bool
    @Binding var renamingName: String
    var onRename: ((String) -> Void)?
    var onCommitRename: ((String) -> Void)?
    var onCancelRename: (() -> Void)?
    var onDelete: (() -> Void)?

    var onToggleExpand: () -> Void
    var onToggleShowAll: () -> Void
    var makeRow: (ConversationModel) -> SidebarConversationItem

    /// Schedule sub-group state -- managed by the parent's SidebarInteractionState.
    /// Passed in so SidebarSectionView can render sub-group disclosure headers.
    var expandedScheduleGroups: Binding<Set<String>>?
    /// Drop delegate plumbing for schedule reorder.
    var sidebar: SidebarInteractionState?
    var conversationManager: ConversationManager?

    enum CountMode {
        case items
        case subGroups(grouper: (ConversationModel) -> String?)
    }

    /// Auto-show-all when hidden items beyond the truncation cutoff have unread messages.
    /// Works for both flat items and schedule sub-groups.
    private var effectiveShowAll: Bool {
        if showAll { return true }
        switch countMode {
        case .items:
            let hidden = conversations.dropFirst(maxCollapsed)
            return hidden.contains(where: \.hasUnseenLatestAssistantMessage)
        case .subGroups(let grouper):
            let subGroups = buildSubGroups(grouper: grouper)
            let hidden = subGroups.dropFirst(maxCollapsed)
            return hidden.contains(where: { subGroup in
                subGroup.conversations.contains(where: \.hasUnseenLatestAssistantMessage)
            })
        }
    }

    private var unreadCount: Int {
        conversations.filter(\.hasUnseenLatestAssistantMessage).count
    }

    private var displayCount: Int {
        switch countMode {
        case .items:
            return conversations.count
        case .subGroups(let grouper):
            var seen = Set<String>()
            for c in conversations {
                if let key = grouper(c) {
                    seen.insert(key)
                } else {
                    seen.insert(c.id.uuidString)
                }
            }
            return seen.count
        }
    }

    var body: some View {
        if let group = group {
            SidebarSectionHeader(
                group: group,
                conversationCount: displayCount,
                isExpanded: isExpanded,
                isDropTarget: isDropTarget,
                unreadCount: unreadCount,
                isRenaming: isRenaming,
                renamingName: $renamingName,
                onToggleExpand: onToggleExpand,
                onRename: onRename,
                onCommitRename: onCommitRename,
                onCancelRename: onCancelRename,
                onDelete: onDelete
            )
            .modifier(SectionHeaderDropModifier(
                group: group,
                sidebar: sidebar,
                conversationManager: conversationManager
            ))

            if isExpanded {
                sectionContent
                    .transition(.opacity.combined(with: .move(edge: .top)))
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
                    .padding(.bottom, SidebarLayoutMetrics.listRowGap)
            }
        }

        showMoreLessButton
    }

    @ViewBuilder
    private func scheduleSubGroupContent(grouper: (ConversationModel) -> String?) -> some View {
        let subGroups = buildSubGroups(grouper: grouper)
        let displayed = effectiveShowAll ? subGroups : Array(subGroups.prefix(maxCollapsed))

        ForEach(displayed, id: \.key) { subGroup in
            if subGroup.conversations.count == 1, let conversation = subGroup.conversations.first {
                // Single-conversation sub-group: render inline
                scheduleRow(conversation)
            } else {
                // Multi-conversation sub-group: disclosure header
                scheduleSubGroupDisclosure(subGroup)
            }
        }

        if subGroups.count > maxCollapsed {
            showMoreLessButtonForSchedule
        }
    }

    @ViewBuilder
    private func scheduleRow(_ conversation: ConversationModel) -> some View {
        if let sidebar, let conversationManager {
            makeRow(conversation)
                .equatable()
                .padding(.bottom, SidebarLayoutMetrics.listRowGap)
                .overlay(alignment: sidebar.dropIndicatorAtBottom ? .bottom : .top) {
                    if sidebar.dropTargetConversationId == conversation.id {
                        Rectangle()
                            .fill(VColor.primaryBase)
                            .frame(height: 2)
                            .transition(.opacity)
                    }
                }
                .onDrop(of: [.plainText], delegate: ScheduleReorderDropDelegate(
                    targetConversation: conversation,
                    sidebar: sidebar,
                    conversationManager: conversationManager
                ))
        } else {
            makeRow(conversation)
                .equatable()
                .padding(.bottom, SidebarLayoutMetrics.listRowGap)
        }
    }

    @ViewBuilder
    private func scheduleSubGroupDisclosure(_ subGroup: ScheduleSubGroup) -> some View {
        let isSubGroupExpanded = expandedScheduleGroups?.wrappedValue.contains(subGroup.key) ?? false
        let hasUnread = !isSubGroupExpanded &&
            subGroup.conversations.contains(where: \.hasUnseenLatestAssistantMessage)

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
                HStack(spacing: 2) {
                    VIconView(.chevronRight, size: 10)
                        .foregroundStyle(VColor.contentTertiary)
                        .rotationEffect(.degrees(isSubGroupExpanded ? 90 : 0))
                        .animation(VAnimation.fast, value: isSubGroupExpanded)
                    if hasUnread {
                        Circle()
                            .fill(VColor.systemNegativeStrong)
                            .frame(width: 6, height: 6)
                            .transition(.opacity)
                    }
                }
                .frame(height: SidebarLayoutMetrics.iconSlotSize)
                Text(subGroup.label)
                    .font(.system(size: 13))
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text("\(subGroup.conversations.count)")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(VColor.contentTertiary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        Capsule()
                            .fill(VColor.contentTertiary.opacity(0.12))
                    )
                Spacer()
            }
            .padding(.leading, VSpacing.xs)
            .padding(.trailing, VSpacing.sm)
            .padding(.vertical, SidebarLayoutMetrics.rowVerticalPadding)
            .frame(minHeight: SidebarLayoutMetrics.rowMinHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, VSpacing.sm)
        .pointerCursor()

        if isSubGroupExpanded {
            ForEach(subGroup.conversations) { conversation in
                scheduleRow(conversation)
            }
        }

        // Drop target on collapsed sub-group header
        if !isSubGroupExpanded, let sidebar, let conversationManager {
            Color.clear
                .frame(height: 0)
                .onDrop(of: [.plainText], delegate: ScheduleSubGroupHeaderDropDelegate(
                    subGroup: subGroup,
                    sidebar: sidebar,
                    conversationManager: conversationManager
                ))
        }
    }

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
                }
                Spacer()
            }
            .padding(.leading, VSpacing.xs + SidebarLayoutMetrics.iconSlotSize + VSpacing.xs - VSpacing.sm)
            .padding(.bottom, VSpacing.xs)
        }
    }

    @ViewBuilder
    private var showMoreLessButtonForSchedule: some View {
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

/// Drop delegate for collapsed schedule sub-group headers within SidebarSectionView.
/// Replaces the old ScheduleGroupHeaderDropDelegate that consumed the deleted
/// scheduleConversationGroups tuple.
struct ScheduleSubGroupHeaderDropDelegate: DropDelegate {
    let subGroup: ScheduleSubGroup
    let sidebar: SidebarInteractionState
    let conversationManager: ConversationManager

    private var firstConversation: ConversationModel? { subGroup.conversations.first }

    func validateDrop(info: DropInfo) -> Bool {
        guard let firstConversation = firstConversation,
              let dragId = sidebar.draggingConversationId,
              dragId != firstConversation.id,
              let sourceConversation = conversationManager.visibleConversations.first(where: { $0.id == dragId }),
              sourceConversation.isScheduleConversation,
              sourceConversation.groupId == firstConversation.groupId,
              sourceConversation.scheduleJobId == firstConversation.scheduleJobId
        else { return false }
        return true
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        return DropProposal(operation: .move)
    }

    func dropEntered(info: DropInfo) {
        guard let firstConversation = firstConversation,
              let dragId = sidebar.draggingConversationId,
              dragId != firstConversation.id,
              let sourceConversation = conversationManager.visibleConversations.first(where: { $0.id == dragId }),
              sourceConversation.isScheduleConversation,
              sourceConversation.groupId == firstConversation.groupId,
              sourceConversation.scheduleJobId == firstConversation.scheduleJobId
        else { return }

        sidebar.dropTargetConversationId = firstConversation.id
        sidebar.dropIndicatorAtBottom = false
    }

    func dropExited(info: DropInfo) {
        if let firstConversation = firstConversation, sidebar.dropTargetConversationId == firstConversation.id {
            sidebar.dropTargetConversationId = nil
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        let sourceId = sidebar.draggingConversationId
        sidebar.dropTargetConversationId = nil
        sidebar.draggingConversationId = nil
        guard let firstConversation = firstConversation,
              let sourceId = sourceId,
              sourceId != firstConversation.id
        else { return false }
        return conversationManager.moveConversation(sourceId: sourceId, targetId: firstConversation.id)
    }
}

/// Drop delegate for reordering conversations within a grouped (non-schedule) section.
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
        // Use section-local index for direction detection (not global visibleConversations)
        let groupConversations = conversationManager.groupedConversations
            .first { $0.group?.id == groupId }?.conversations ?? []
        let sIdx = groupConversations.firstIndex(where: { $0.id == dragId })
        let tIdx = groupConversations.firstIndex(where: { $0.id == targetConversation.id }) ?? 0
        if let sIdx {
            // Same-group drag: compare indices to determine direction
            sidebar.dropIndicatorAtBottom = sIdx < tIdx
        } else {
            // Cross-group drag: source isn't in this section, default to top
            // indicator (insert before the target) so the visual position matches
            // the actual insertion point.
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
        sidebar.draggingConversationId = nil
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
