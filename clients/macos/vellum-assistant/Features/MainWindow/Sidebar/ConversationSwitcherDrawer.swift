import SwiftUI
import VellumAssistantShared

struct ConversationSwitcherDrawer: View {
    var conversationManager: ConversationManager
    @ObservedObject var windowState: MainWindowState
    var sidebar: SidebarInteractionState
    var customGroupsEnabled: Bool = false
    let selectConversation: (ConversationModel) -> Void
    let onDismiss: () -> Void

    /// Max conversations shown per section before "Show more".
    private let maxPerSection = 5

    /// Tracks which sections have been expanded via "Show more".
    /// Recents starts expanded so conversations are visible.
    @State private var expandedSections: Set<String> = [ConversationGroup.all.id]

    /// Tracks which sub-groups (schedule/background) are expanded in the drawer.
    @State private var expandedSubGroups: Set<String> = []

    /// Group entries filtered by flags: custom groups merged into system:all when their flag is off.
    private var drawerEntries: [(group: ConversationGroup, conversations: [ConversationModel])] {
        let raw = conversationManager.groupedConversations
        var entries: [(ConversationGroup, [ConversationModel])] = []
        var extraForAll: [ConversationModel] = []
        for entry in raw {
            guard let group = entry.group else { continue }
            if !group.isSystemGroup && !customGroupsEnabled {
                extraForAll.append(contentsOf: entry.conversations)
            } else {
                entries.append((group, entry.conversations))
            }
        }
        // Merge extra conversations into the system:all entry
        if !extraForAll.isEmpty {
            if let allIndex = entries.firstIndex(where: { $0.group.id == ConversationGroup.all.id }) {
                let existing = entries[allIndex]
                entries[allIndex] = (existing.group, existing.conversations + extraForAll)
            } else {
                // system:all absent from entries — create one so conversations aren't dropped
                entries.append((ConversationGroup.all, extraForAll))
            }
        }
        return entries
    }
    /// Measured content height for size-to-fit behavior.
    @State private var contentHeight: CGFloat = 0

    private func isConversationSelected(_ conversation: ConversationModel) -> Bool {
        switch windowState.selection {
        case .panel:
            return false
        case .conversation(let id):
            return id == conversation.id
        case .appEditing(_, let conversationId):
            return conversationId == conversation.id
        case .app, .none:
            return conversation.id == windowState.persistentConversationId
        }
    }

    private func makeRow(_ conversation: ConversationModel) -> SidebarConversationItem {
        SidebarConversationItem(
            conversation: conversation,
            isSelected: isConversationSelected(conversation),
            interactionState: conversationManager.interactionState(for: conversation.id),
            selectConversation: { selectConversation(conversation) },
            onSelect: onDismiss,
            onTogglePin: {
                withAnimation(VAnimation.standard) {
                    if conversation.isPinned {
                        conversationManager.unpinConversation(id: conversation.id)
                    } else {
                        conversationManager.pinConversation(id: conversation.id)
                    }
                }
            },
            onArchive: { conversationManager.archiveConversation(id: conversation.id) },
            onStartRename: {
                sidebar.renamingConversationId = conversation.id
                sidebar.renameText = conversation.title
            },
            onMarkUnread: { conversationManager.markConversationUnread(conversationId: conversation.id) },
            onDragStart: {
                sidebar.beginConversationDrag(conversation.id)
            },
            onAnalyze: conversation.conversationId != nil && !conversation.isChannelConversation && conversation.kind != .private ? {
                selectConversation(conversation)
                Task<Void, Never> { await conversationManager.analyzeActiveConversation() }
            } : nil,
            onOpenInNewWindow: conversation.conversationId != nil ? {
                AppDelegate.shared?.threadWindowManager?.openThread(
                    conversationLocalId: conversation.id,
                    conversationManager: conversationManager
                )
            } : nil,
            onShowFeedback: conversation.conversationId != nil && !LogExporter.isManagedAssistant ? {
                AppDelegate.shared?.showLogReportWindow(scope: .conversation(conversationId: conversation.conversationId!, conversationTitle: conversation.title))
            } : nil
        )
    }

    var body: some View {
        GeometryReader { geo in
            let maxHeight = geo.size.height * 0.75
            let isScrollable = contentHeight > maxHeight

            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    let nonEmptyEntries = drawerEntries.filter { !$0.conversations.isEmpty }
                    ForEach(nonEmptyEntries.indices, id: \.self) { index in
                        let entry = nonEmptyEntries[index]
                        let sectionId = entry.group.id
                        let isExpanded = expandedSections.contains(sectionId)

                        if index > 0 {
                            VMenuDivider()
                        }
                        sectionContent(
                            sectionId: sectionId,
                            group: entry.group,
                            title: entry.group.name,
                            conversations: entry.conversations,
                            isExpanded: isExpanded
                        )
                    }
                }
                .background(GeometryReader { contentGeo in
                    Color.clear.preference(
                        key: DrawerContentHeightKey.self,
                        value: contentGeo.size.height + VSpacing.sm * 2
                    )
                })
            }
            .onPreferenceChange(DrawerContentHeightKey.self) { contentHeight = $0 }
            .scrollBounceBehavior(.basedOnSize)
            .padding(VSpacing.sm)
            .frame(height: min(contentHeight, maxHeight))
            .background(VColor.surfaceLift)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
            .shadow(color: VColor.auxBlack.opacity(0.1), radius: 1.5, x: 0, y: 1)
            .shadow(color: VColor.auxBlack.opacity(0.1), radius: 6, x: 0, y: 4)
            .overlay(alignment: .bottom) {
                if isScrollable {
                    LinearGradient(
                        colors: [VColor.surfaceLift.opacity(0), VColor.surfaceLift],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .frame(height: 28)
                    .clipShape(UnevenRoundedRectangle(
                        bottomLeadingRadius: VRadius.lg,
                        bottomTrailingRadius: VRadius.lg
                    ))
                    .allowsHitTesting(false)
                }
            }
        }
    }

    @ViewBuilder
    private func sectionContent(
        sectionId: String,
        group: ConversationGroup,
        title: String,
        conversations: [ConversationModel],
        isExpanded: Bool
    ) -> some View {
        HStack {
            Text(title)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentTertiary)
            Spacer()
            Text("\(conversations.count)")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.top, VSpacing.xs)
        .padding(.bottom, VSpacing.xs)

        let isScheduled = group.id == ConversationGroup.scheduled.id
        let isBackground = group.id == ConversationGroup.background.id

        if isScheduled || isBackground {
            let grouper: (ConversationModel) -> String? = isScheduled ? { $0.scheduleJobId } : { $0.source }
            let labelProvider: ((String, [ConversationModel]) -> String)? = isBackground
                ? { key, _ in key.prefix(1).uppercased() + key.dropFirst() }
                : nil
            let subGroups = buildDrawerSubGroups(conversations: conversations, grouper: grouper, labelProvider: labelProvider)
            let displayed = isExpanded ? subGroups : Array(subGroups.prefix(maxPerSection))

            ForEach(displayed) { subGroup in
                if subGroup.conversations.count == 1, let conversation = subGroup.conversations.first {
                    makeRow(conversation)
                        .equatable()
                        .id(ConversationRowIdentity(conversationId: conversation.id, groupId: conversation.groupId))
                } else {
                    drawerSubGroupDisclosure(subGroup, sectionId: sectionId)
                }
            }

            if subGroups.count > maxPerSection {
                drawerShowMoreLess(sectionId: sectionId, totalCount: subGroups.count, isExpanded: isExpanded)
            }
        } else {
            let displayed = isExpanded ? conversations : Array(conversations.prefix(maxPerSection))
            ForEach(displayed) { conversation in
                makeRow(conversation)
                    .equatable()
                    .id(ConversationRowIdentity(conversationId: conversation.id, groupId: conversation.groupId))
            }

            if conversations.count > maxPerSection {
                drawerShowMoreLess(sectionId: sectionId, totalCount: conversations.count, isExpanded: isExpanded)
            }
        }
    }

    @ViewBuilder
    private func drawerShowMoreLess(sectionId: String, totalCount: Int, isExpanded: Bool) -> some View {
        HStack {
            VButton(
                label: isExpanded ? "Show less" : "Show more (\(totalCount - maxPerSection))",
                style: .ghost,
                size: .compact
            ) {
                withAnimation(VAnimation.fast) {
                    if isExpanded {
                        expandedSections.remove(sectionId)
                    } else {
                        expandedSections.insert(sectionId)
                        conversationManager.loadAllRemainingConversations()
                    }
                }
            }
            Spacer()
        }
        .padding(.leading, VSpacing.sm)
    }

    @ViewBuilder
    private func drawerSubGroupDisclosure(_ subGroup: ScheduleSubGroup, sectionId: String) -> some View {
        let scopedKey = "\(sectionId):\(subGroup.key)"
        let isSubGroupExpanded = expandedSubGroups.contains(scopedKey)
        let hasUnread = !isSubGroupExpanded &&
            subGroup.conversations.contains(where: \.hasUnseenLatestAssistantMessage)

        Button {
            withAnimation(VAnimation.fast) {
                if isSubGroupExpanded {
                    expandedSubGroups.remove(scopedKey)
                } else {
                    expandedSubGroups.insert(scopedKey)
                }
            }
        } label: {
            HStack(spacing: VSpacing.xs) {
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

    private func buildDrawerSubGroups(
        conversations: [ConversationModel],
        grouper: (ConversationModel) -> String?,
        labelProvider: ((String, [ConversationModel]) -> String)?
    ) -> [ScheduleSubGroup] {
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
            guard let convs = grouped[key], let first = convs.first else { return nil }
            let label: String
            if let provider = labelProvider {
                label = provider(key, convs)
            } else if convs.count > 1 {
                let base = first.title
                if let colonRange = base.range(of: ":") {
                    label = String(base[base.startIndex..<colonRange.lowerBound])
                } else {
                    label = base
                }
            } else {
                label = first.title
            }
            return ScheduleSubGroup(key: key, label: label, conversations: convs)
        }
    }
}

private struct DrawerContentHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}
