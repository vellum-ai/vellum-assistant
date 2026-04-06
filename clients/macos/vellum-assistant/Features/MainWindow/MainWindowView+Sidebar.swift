import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

// MARK: - Sidebar Group Entry

/// Lightweight identifiable wrapper for ForEach over grouped conversations.
private struct SidebarGroupEntry: Identifiable {
    let id: String
    let group: ConversationGroup?
    let conversations: [ConversationModel]
}

// MARK: - Sidebar Content

extension MainWindowView {

    func selectConversation(_ conversation: ConversationModel) {
        if case .appEditing(_, let currentId) = windowState.selection,
           currentId == conversation.id {
            // Tapping the already-active conversation while editing an app
            // should not dismiss the app panel.
            return
        }
        windowState.selection = .conversation(conversation.id)
        conversationManager.selectConversation(id: conversation.id)

        // Auto-expand the section containing the selected conversation
        // so it's always visible in the sidebar.
        if let groupId = conversation.groupId,
           !sidebar.expandedSections.contains(groupId) {
            sidebar.expandedSections.insert(groupId)
        }
    }

    func startNewConversation() {
        conversationManager.createConversation()
        SoundManager.shared.play(.newConversation)
        if let id = conversationManager.activeConversationId {
            windowState.selection = .conversation(id)
        } else {
            // Draft mode — clear selection so no sidebar conversation is highlighted
            windowState.selection = nil
            windowState.persistentConversationId = nil
        }
    }

    /// All non-schedule/non-background conversations for the collapsed sidebar switcher.
    /// Flat count regardless of custom group membership.
    var regularConversations: [ConversationModel] {
        conversationManager.visibleConversations.filter { !$0.isScheduleConversation && !$0.isBackgroundConversation && !$0.isChannelConversation }
    }

    /// Unread count in the Scheduled section, used to trigger auto-expand.
    /// Filters `conversations` directly instead of calling `visibleConversations` to avoid
    /// an unnecessary O(N log N) sort — only the count is needed.
    private var scheduledUnreadCount: Int {
        conversationManager.conversations
            .count { !$0.isArchived && $0.kind != .private && $0.groupId == ConversationGroup.scheduled.id && $0.hasUnseenLatestAssistantMessage }
    }

    var displayedApps: [AppListManager.AppItem] {
        let all = appListManager.displayApps
        return sidebar.showAllApps ? all : Array(all.prefix(5))
    }

    var sidebarOuterMargin: CGFloat { 16 }

    @ViewBuilder
    var sidebarView: some View {
        VStack(spacing: 0) {
            if sidebarExpanded {
                expandedSidebarContent
            } else {
                collapsedSidebarContent
            }
        }
        .padding(.vertical, VSpacing.md)
        .padding(.horizontal, sidebarExpanded ? VSpacing.md : VSpacing.sm)
        .frame(maxHeight: .infinity)
        .frame(width: sidebarExpanded ? sidebarExpandedWidth : sidebarCollapsedWidth, alignment: .leading)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .clipped()
        .alert("Rename Conversation", isPresented: Binding(
            get: { sidebar.renamingConversationId != nil },
            set: { if !$0 { sidebar.renamingConversationId = nil } }
        )) {
            TextField("Title", text: Binding(
                get: { sidebar.renameText },
                set: { sidebar.renameText = $0 }
            ))
            Button("Cancel", role: .cancel) { sidebar.renamingConversationId = nil }
            Button("Save") {
                if let id = sidebar.renamingConversationId {
                    conversationManager.renameConversation(id: id, title: sidebar.renameText)
                }
                sidebar.renamingConversationId = nil
            }
        } message: {
            Text("Enter a new name for this conversation")
        }
    }

    // MARK: - Sidebar Row Factory

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

    /// Builds a `SidebarSectionView` for a group. Extracted from the ForEach body
    /// to reduce type-checker pressure (the init has many parameters).
    private func makeSectionView(group: ConversationGroup, conversations: [ConversationModel]) -> SidebarSectionView {
        let isPinned = group.id == ConversationGroup.pinned.id
        let isScheduled = group.id == ConversationGroup.scheduled.id
        let isBackground = group.id == ConversationGroup.background.id
        let countMode: SidebarSectionView.CountMode = isScheduled
            ? .subGroups(grouper: { $0.scheduleJobId })
            : isBackground
                ? .subGroups(grouper: { $0.source })
                : .items
        let subGroupLabelProvider: ((String, [ConversationModel]) -> String)? = isBackground
            ? { key, _ in key.prefix(1).uppercased() + key.dropFirst() }
            : nil
        let expandedSubGroups: Binding<Set<String>>? = isScheduled
            ? Binding(get: { sidebar.expandedScheduleGroups }, set: { sidebar.expandedScheduleGroups = $0 })
            : isBackground
                ? Binding(get: { sidebar.expandedBackgroundGroups }, set: { sidebar.expandedBackgroundGroups = $0 })
                : nil
        return SidebarSectionView(
            group: group,
            conversations: conversations,
            isExpanded: sidebar.expandedSections.contains(group.id),
            showAll: sidebar.showAllInSection.contains(group.id),
            maxCollapsed: isPinned ? .max : 5,
            isDropTarget: sidebar.dropTargetSectionId == group.id,
            countMode: countMode,
            isRenaming: sidebar.renamingGroupId == group.id,
            renamingName: Binding(
                get: { sidebar.renamingGroupName },
                set: { sidebar.renamingGroupName = $0 }
            ),
            onRename: { name in
                sidebar.renamingGroupId = group.id
                sidebar.renamingGroupName = name
            },
            onCommitRename: { newName in
                sidebar.renamingGroupId = nil
                Task<Void, Never> { await conversationManager.renameGroup(group.id, name: newName) }
            },
            onCancelRename: {
                sidebar.renamingGroupId = nil
            },
            onDelete: group.isSystemGroup ? nil : {
                if conversations.isEmpty {
                    Task<Void, Never> { await conversationManager.deleteGroup(group.id) }
                } else {
                    groupToDelete = group
                }
            },
            selectedConversationId: conversationManager.activeConversationId,
            onToggleExpand: { sidebar.toggleSection(group.id) },
            onToggleShowAll: { sidebar.toggleShowAll(group.id) },
            makeRow: { makeSidebarRow(conversation: $0) },
            expandedScheduleGroups: expandedSubGroups,
            subGroupLabelProvider: subGroupLabelProvider,
            sidebar: sidebar,
            conversationManager: conversationManager
        )
    }

    /// Builds a `SidebarConversationItem` with all state pre-resolved and closures wired,
    /// so each row is a pure value view that can be skipped via `Equatable`.
    private func makeSidebarRow(
        conversation: ConversationModel,
        onSelect: (() -> Void)? = nil
    ) -> SidebarConversationItem {
        SidebarConversationItem(
            conversation: conversation,
            isSelected: isConversationSelected(conversation),
            interactionState: conversationManager.interactionState(for: conversation.id),
            selectConversation: { selectConversation(conversation) },
            onSelect: onSelect,
            onTogglePin: {
                // Look up current pin state from the live conversations array,
                // not the captured struct value (which may be stale).
                let currentlyPinned = conversationManager.conversations
                    .first(where: { $0.id == conversation.id })?.isPinned ?? false
                if currentlyPinned {
                    conversationManager.unpinConversation(id: conversation.id)
                } else {
                    conversationManager.pinConversation(id: conversation.id)
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
            } : nil,
            moveToGroups: conversationManager.groups.filter { group in
                group.id != conversation.groupId &&
                (assistantFeatureFlagStore.isEnabled("conversation-groups-ui") || group.isSystemGroup)
            },
            onMoveToGroup: { targetGroupId in
                if let targetGroupId, targetGroupId == ConversationGroup.pinned.id {
                    // Route through pinConversation to get correct bottom-append ordering.
                    conversationManager.pinConversation(id: conversation.id)
                } else {
                    conversationManager.moveConversationToGroup(conversation.id, groupId: targetGroupId)
                }
            }
        )
    }

    // MARK: - Ungrouped Rows

    /// The main conversation groups list content, extracted from the ScrollView body
    /// to reduce type-checker pressure (avoids "ambiguous use of init" on ScrollView).
    @ViewBuilder
    private var conversationGroupsList: some View {
        LazyVStack(spacing: 0) {
            if showDaemonLoading && !assistantLoadingTimedOut && conversationManager.visibleConversations.isEmpty {
                DaemonLoadingConversationsSkeleton()
            }

            let customGroupsEnabled = assistantFeatureFlagStore.isEnabled("conversation-groups-ui")
            let groupEntries: [SidebarGroupEntry] = {
                let raw = conversationManager.groupedConversations
                var entries: [SidebarGroupEntry] = []
                var extraUngrouped: [ConversationModel] = []
                for entry in raw {
                    if let group = entry.group {
                        // Hide custom groups when custom groups flag is off
                        if !group.isSystemGroup && !customGroupsEnabled {
                            extraUngrouped.append(contentsOf: entry.conversations)
                        } else {
                            entries.append(SidebarGroupEntry(id: group.id, group: group, conversations: entry.conversations))
                        }
                    } else {
                        extraUngrouped.append(contentsOf: entry.conversations)
                    }
                }
                entries.append(SidebarGroupEntry(id: "ungrouped", group: nil, conversations: extraUngrouped))
                return entries
            }()
            ForEach(groupEntries) { entry in
                if let group = entry.group {
                    makeSectionView(group: group, conversations: entry.conversations)
                } else {
                    ungroupedConversationRows(entry.conversations)
                }
            }

        }
    }

    /// Renders ungrouped conversations with drag-reorder support.
    /// These appear without a collapsible header, matching the pre-groups layout.
    @ViewBuilder
    private func ungroupedConversationRows(_ conversations: [ConversationModel]) -> some View {
        let displayed = sidebar.showAllInSection.contains("ungrouped")
            ? conversations
            : Array(conversations.prefix(5))

        ForEach(displayed) { conversation in
            makeSidebarRow(conversation: conversation)
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
                    let moved = conversationManager.moveConversation(sourceId: sourceUUID, targetId: conversation.id)
                    sidebar.endConversationDrag()
                    return moved
                } isTargeted: { isTargeted in
                    if isTargeted && conversation.id != sidebar.draggingConversationId {
                        sidebar.dropTargetConversationId = conversation.id
                        if let dragId = sidebar.draggingConversationId {
                            // Use section-local index (ungrouped conversations only)
                            let ungroupedConvs = conversationManager.groupedConversations
                                .first { $0.group == nil }?.conversations ?? []
                            let sIdx = ungroupedConvs.firstIndex(where: { $0.id == dragId }) ?? 0
                            let tIdx = ungroupedConvs.firstIndex(where: { $0.id == conversation.id }) ?? 0
                            sidebar.dropIndicatorAtBottom = sIdx < tIdx
                        }
                    } else if !isTargeted && sidebar.dropTargetConversationId == conversation.id {
                        sidebar.dropTargetConversationId = nil
                    }
                }
        }

        if conversations.count > 5 {
            HStack {
                VButton(
                    label: sidebar.showAllInSection.contains("ungrouped") ? "Show less" : "Show more",
                    style: .ghost,
                    size: .compact
                ) {
                    let wasCollapsed = !sidebar.showAllInSection.contains("ungrouped")
                    withAnimation(VAnimation.fast) { sidebar.toggleShowAll("ungrouped") }
                    if wasCollapsed {
                        conversationManager.loadAllRemainingConversations()
                    }
                }
                Spacer()
            }
            .padding(.leading, VSpacing.xs + SidebarLayoutMetrics.iconSlotSize + VSpacing.xs - VSpacing.sm)
            .padding(.bottom, VSpacing.xs)
        }

        // Fallback pagination: the ungrouped section is always the last
        // rendered section. When every section fits within its collapse
        // limit (no "Show more" buttons visible) but the server has more
        // conversations, auto-trigger loading so users can reach them.
        // Gate on ALL sections — not just ungrouped — to avoid eager
        // full-load in grouped-heavy workspaces.
        if conversations.count <= 5,
           conversationManager.hasMoreConversations,
           !conversationManager.groupedConversations.contains(where: { entry in
               guard let group = entry.group else { return false }
               let limit = group.id == ConversationGroup.pinned.id ? Int.max : 5
               return entry.conversations.count > limit
           }) {
            Color.clear
                .frame(height: 0)
                .onAppear {
                    conversationManager.loadAllRemainingConversations()
                }
        }
    }

    // MARK: - Pinned App Helpers

    /// A pinned app row — delegates layout to `SidebarPrimaryRow` for both
    /// expanded and collapsed modes, then adds app-specific context menu and drag.
    @ViewBuilder
    func sidebarPinnedAppRow(_ app: AppListManager.AppItem, isExpanded: Bool = true) -> some View {
        SidebarPrimaryRow(
            icon: app.lucideIcon ?? VIcon.layoutGrid.rawValue,
            label: app.name,
            isActive: isAppSurfaceActive(appId: app.id),
            isExpanded: isExpanded
        ) {
            openAppInWorkspace(app: app)
        }
        .contextMenu {
            Button(app.isPinned ? "Unpin" : "Pin to Top") {
                if app.isPinned {
                    appListManager.unpinApp(id: app.id)
                } else {
                    appListManager.pinApp(id: app.id)
                }
            }
            Button("Open") {
                openAppInWorkspace(app: app)
            }
            Divider()
            Button("Remove from Recents", role: .destructive) {
                appListManager.removeApp(id: app.id)
            }
        }
        .draggable(app.id)
    }

    @ViewBuilder
    var expandedSidebarContent: some View {
        VStack(spacing: SidebarLayoutMetrics.listRowGap) {
            // MARK: Pinned Apps (above nav items)
            if !appListManager.pinnedApps.isEmpty {
                VStack(spacing: SidebarLayoutMetrics.listRowGap) {
                    ForEach(appListManager.pinnedApps) { app in
                        sidebarPinnedAppRow(app)
                    }
                }
                .drawingGroup() // Isolate into Metal layer to prevent re-renders from sibling hover

                sidebarSectionDivider()
            }

            // MARK: Nav Items (fixed)
            SidebarNavRow(icon: VIcon.brain.rawValue, label: cachedAssistantName, isActive: windowState.selection == .panel(.intelligence)) {
                windowState.showPanel(.intelligence)
            }
            SidebarNavRow(icon: VIcon.layoutGrid.rawValue, label: "Library", isActive: windowState.selection == .panel(.apps)) {
                windowState.showPanel(.apps)
            }
            // Divider between nav items and conversations
            sidebarSectionDivider()

            // MARK: Conversations (scrollable)
            SidebarConversationsHeader(
                hasUnseenConversations: conversationManager.unseenVisibleConversationCount > 0,
                isLoading: showDaemonLoading,
                onMarkAllSeen: {
                    let markedIds = conversationManager.markAllConversationsSeen()
                    guard !markedIds.isEmpty else { return }
                    let count = markedIds.count
                    let toastId = windowState.showToast(
                        message: "Marked \(count) conversation\(count == 1 ? "" : "s") as seen",
                        style: .success,
                        primaryAction: VToastAction(label: "Undo") {
                            conversationManager.restoreUnseen(conversationIds: markedIds)
                            windowState.dismissToast()
                        },
                        onDismiss: {
                            conversationManager.commitPendingSeenSignals()
                        }
                    )
                    conversationManager.schedulePendingSeenSignals {
                        windowState.dismissToast(id: toastId)
                    }
                },
                onNewConversation: { startNewConversation() },
                onCreateGroup: assistantFeatureFlagStore.isEnabled("conversation-groups-ui") ? {
                    Task<Void, Never> {
                        if let group = await conversationManager.createGroup(name: "New Group") {
                            sidebar.expandedSections.insert(group.id)
                            sidebar.renamingGroupId = group.id
                            sidebar.renamingGroupName = group.name
                        }
                    }
                } : nil
            )

            ScrollView(.vertical, showsIndicators: false) {
                conversationGroupsList
                    .background(GeometryReader { contentGeo in
                        Color.clear.preference(
                            key: SidebarContentHeightKey.self,
                            value: contentGeo.size.height
                        )
                    })
            }
            .sheet(item: $groupToDelete) { group in
                DeleteGroupConfirmationSheet(
                    groupName: group.name,
                    onDelete: {
                        groupToDelete = nil
                        Task<Void, Never> { await conversationManager.deleteGroup(group.id) }
                    },
                    onArchiveAndDelete: {
                        groupToDelete = nil
                        Task<Void, Never> { await conversationManager.deleteGroupAndArchiveConversations(group.id) }
                    },
                    onCancel: {
                        groupToDelete = nil
                    }
                )
            }
            .background(GeometryReader { scrollGeo in
                Color.clear.preference(
                    key: SidebarFrameHeightKey.self,
                    value: scrollGeo.size.height
                )
            })
            .onPreferenceChange(SidebarContentHeightKey.self) { sidebarContentHeight = $0 }
            .onPreferenceChange(SidebarFrameHeightKey.self) { sidebarFrameHeight = $0 }
            .overlay(alignment: .bottom) {
                if sidebarContentHeight > sidebarFrameHeight {
                    LinearGradient(
                        colors: [VColor.surfaceOverlay.opacity(0), VColor.surfaceOverlay],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .frame(height: 24)
                    .allowsHitTesting(false)
                }
            }
            .onChange(of: scheduledUnreadCount) { _, newCount in
                // Auto-expand the Scheduled section when new unread arrives
                // while collapsed. Other sections (Background, Custom, Pinned)
                // do NOT auto-expand.
                if newCount > 0 && !sidebar.expandedSections.contains(ConversationGroup.scheduled.id) {
                    _ = withAnimation(VAnimation.fast) {
                        sidebar.expandedSections.insert(ConversationGroup.scheduled.id)
                    }
                }
            }

            Spacer(minLength: VSpacing.sm)

            sidebarSectionDivider()

            // Preferences row (fixed)
            PreferencesRow(
                isActive: sidebar.showPreferencesDrawer,
                isExpanded: true,
                onToggle: {
                    withAnimation(VAnimation.snappy) {
                        sidebar.showPreferencesDrawer.toggle()
                    }
                }
            )
        }
    }

    @ViewBuilder
    var collapsedSidebarContent: some View {
        VStack(spacing: SidebarLayoutMetrics.listRowGap) {
            // MARK: Pinned Apps (collapsed)
            if !appListManager.pinnedApps.isEmpty {
                VStack(spacing: SidebarLayoutMetrics.listRowGap) {
                    ForEach(appListManager.pinnedApps) { app in
                        sidebarPinnedAppRow(app, isExpanded: false)
                    }
                }
                .drawingGroup() // Isolate into Metal layer to prevent re-renders from sibling hover

                sidebarSectionDivider()
            }

            SidebarNavRow(icon: VIcon.brain.rawValue, label: cachedAssistantName, isActive: windowState.selection == .panel(.intelligence), isExpanded: false) {
                windowState.showPanel(.intelligence)
            }
            SidebarNavRow(icon: VIcon.layoutGrid.rawValue, label: "Library", isActive: windowState.selection == .panel(.apps), isExpanded: false) {
                windowState.showPanel(.apps)
            }
            sidebarSectionDivider()

            SidebarNavRow(icon: VIcon.squarePen.rawValue, label: "New Conversation", isActive: false, isExpanded: false) {
                startNewConversation()
            }

            // MARK: Conversation Section (collapsed)
            let switcher = CollapsedConversationSwitcherPresentation(
                regularConversations: regularConversations,
                activeConversationId: conversationManager.activeConversationId
            )
            if switcher.showsSwitcher {
                Button {
                    showConversationSwitcher.toggle()
                } label: {
                    ZStack(alignment: .bottomTrailing) {
                        Text(switcher.badgeText)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(VColor.primaryBase)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, SidebarLayoutMetrics.rowVerticalPadding)
                            .frame(minHeight: SidebarLayoutMetrics.rowMinHeight)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.md)
                                    .fill(windowState.isShowingChat && conversationManager.activeConversation != nil
                                        ? VColor.surfaceActive
                                        : VColor.surfaceBase)
                            )

                        if switcher.switchTargets.contains(where: { $0.hasUnseenLatestAssistantMessage }) {
                            Circle()
                                .fill(VColor.systemNegativeStrong)
                                .frame(width: 8, height: 8)
                                .offset(x: 4, y: 4)
                        }
                    }
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 0)
                .accessibilityLabel(switcher.accessibilityLabel)
                .accessibilityValue(switcher.accessibilityValue)
                .onDisappear {
                    showConversationSwitcher = false
                }
                .pointerCursor()
                .onGeometryChange(for: CGRect.self) { proxy in
                    proxy.frame(in: .named("coreLayout"))
                } action: { newFrame in
                    conversationSwitcherTriggerFrame = newFrame
                }
            }

            Spacer()

            sidebarSectionDivider()

            PreferencesRow(
                isActive: sidebar.showPreferencesDrawer,
                isExpanded: false,
                onToggle: {
                    withAnimation(VAnimation.snappy) {
                        sidebar.showPreferencesDrawer.toggle()
                    }
                }
            )
        }
    }

    // MARK: - Section Divider

    @ViewBuilder
    func sidebarSectionDivider() -> some View {
        VColor.surfaceActive
            .frame(height: 1)
            .padding(.vertical, SidebarLayoutMetrics.dividerVerticalPadding)
    }

    // MARK: - App View Helpers

    /// Check if a given appId matches the currently active workspace surface.
    func isAppSurfaceActive(appId: String) -> Bool {
        guard let surfaceMsg = windowState.activeDynamicSurface,
              let surface = windowState.activeDynamicParsedSurface,
              case .dynamicPage(let dpData) = surface.data else { return false }
        return dpData.appId == appId || surfaceMsg.surfaceId.contains(appId)
    }

    /// Open an app in the workspace view (main content area).
    func openAppInWorkspace(app: AppListManager.AppItem) {
        // Reset sticky chat dock so apps open in view-only mode by default
        isAppChatOpen = false
        appListManager.recordAppOpen(
            id: app.id,
            name: app.name,
            icon: app.icon,
            previewBase64: app.previewBase64,
            appType: app.appType
        )
        Task { await AppsClient.openAppAndDispatchSurface(id: app.id, connectionManager: connectionManager, eventStreamClient: eventStreamClient) }
    }
}

// MARK: - Sidebar Scroll Overflow Detection

private struct SidebarContentHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct SidebarFrameHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}
