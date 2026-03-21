import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

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

    var regularConversations: [ConversationModel] {
        conversationManager.visibleConversations.filter { !$0.isScheduleConversation }
    }

    var scheduleConversations: [ConversationModel] {
        conversationManager.visibleConversations.filter { $0.isScheduleConversation }
    }

    var displayedConversations: [ConversationModel] {
        let all = regularConversations
        return sidebar.showAllConversations ? all : Array(all.prefix(5))
    }

    var displayedScheduleConversations: [ConversationModel] {
        let all = scheduleConversations
        return sidebar.showAllScheduleConversations ? all : Array(all.prefix(3))
    }

    /// Groups schedule conversations by their scheduleJobId.
    /// Conversations without a scheduleJobId are placed in individual groups keyed by their conversation ID.
    var scheduleConversationGroups: [(key: String, label: String, conversations: [ConversationModel])] {
        var grouped: [String: [ConversationModel]] = [:]
        var order: [String] = []
        for conversation in scheduleConversations {
            let key = conversation.scheduleJobId ?? conversation.conversationId ?? conversation.id.uuidString
            if grouped[key] == nil {
                order.append(key)
            }
            grouped[key, default: []].append(conversation)
        }
        return order.compactMap { key in
            guard let conversations = grouped[key], let first = conversations.first else { return nil }
            // Use the schedule title prefix (before the colon) as the group label,
            // or fall back to the full title when there's no colon.
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
            return (key: key, label: label, conversations: conversations)
        }
    }

    var displayedScheduleGroups: [(key: String, label: String, conversations: [ConversationModel])] {
        let all = scheduleConversationGroups
        if sidebar.showAllScheduleConversations { return all }
        // Auto-expand if any hidden group has unread conversations.
        let visible = Array(all.prefix(3))
        let hidden = all.dropFirst(3)
        if hidden.contains(where: { group in
            group.conversations.contains(where: { $0.hasUnseenLatestAssistantMessage })
        }) {
            return all
        }
        return visible
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
            SidebarNavRow(icon: VIcon.brain.rawValue, label: "Intelligence", isActive: windowState.selection == .panel(.intelligence)) {
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
                onNewConversation: { startNewConversation() }
            )

            ScrollView {
                VStack(spacing: 0) {
                    if showDaemonLoading && displayedConversations.isEmpty {
                        DaemonLoadingConversationsSkeleton()
                    }

                    ForEach(displayedConversations) { conversation in
                        SidebarConversationItem(
                            conversation: conversation,
                            conversationManager: conversationManager,
                            windowState: windowState,
                            sidebar: sidebar,
                            selectConversation: { selectConversation(conversation) }
                        )
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
                                sidebar.dropTargetConversationId = nil
                                sidebar.draggingConversationId = nil
                                guard let droppedId = items.first,
                                      let sourceUUID = UUID(uuidString: droppedId),
                                      sourceUUID != conversation.id else { return false }
                                return conversationManager.moveConversation(sourceId: sourceUUID, targetId: conversation.id)
                            } isTargeted: { isTargeted in
                                if isTargeted && conversation.id != sidebar.draggingConversationId {
                                    sidebar.dropTargetConversationId = conversation.id
                                    if let dragId = sidebar.draggingConversationId {
                                        let visible = conversationManager.visibleConversations
                                        let sIdx = visible.firstIndex(where: { $0.id == dragId }) ?? 0
                                        let tIdx = visible.firstIndex(where: { $0.id == conversation.id }) ?? 0
                                        sidebar.dropIndicatorAtBottom = sIdx < tIdx
                                    }
                                } else if !isTargeted && sidebar.dropTargetConversationId == conversation.id {
                                    sidebar.dropTargetConversationId = nil
                                }
                            }
                    }

                    if regularConversations.count > 5 {
                        HStack {
                            VButton(
                                label: sidebar.showAllConversations ? "Show less" : "Show more",
                                style: .ghost,
                                size: .compact
                            ) {
                                withAnimation(VAnimation.fast) { sidebar.showAllConversations.toggle() }
                            }
                            Spacer()
                        }
                        .padding(.leading, VSpacing.xs + SidebarLayoutMetrics.iconSlotSize + VSpacing.xs - VSpacing.sm)
                        .padding(.top, VSpacing.sm)
                        .padding(.bottom, VSpacing.xs)
                    }

                    if !scheduleConversations.isEmpty {
                        // Scheduled conversations section
                        HStack {
                            Text("Scheduled")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                            Spacer()
                        }
                        .padding(.leading, SidebarLayoutMetrics.iconSlotSize)
                        .padding(.trailing, VSpacing.md)
                        .padding(.top, SidebarLayoutMetrics.scheduledHeaderTopGap)
                        .padding(.bottom, SidebarLayoutMetrics.scheduledHeaderBottomGap)

                        ForEach(displayedScheduleGroups, id: \.key) { group in
                            if group.conversations.count == 1, let conversation = group.conversations.first {
                                // Single-conversation group: render inline without a disclosure wrapper
                                SidebarConversationItem(
                                    conversation: conversation,
                                    conversationManager: conversationManager,
                                    windowState: windowState,
                                    sidebar: sidebar,
                                    selectConversation: { selectConversation(conversation) }
                                )
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
                                // Multi-conversation group: custom disclosure styled like a nav row
                                let isGroupExpanded = sidebar.expandedScheduleGroups.contains(group.key)
                                let hasUnread = !isGroupExpanded &&
                                    group.conversations.contains(where: { $0.hasUnseenLatestAssistantMessage })

                                // Header row — chevron in icon slot, label + count badge
                                Button {
                                    withAnimation(VAnimation.fast) {
                                        if isGroupExpanded {
                                            sidebar.expandedScheduleGroups.remove(group.key)
                                        } else {
                                            sidebar.expandedScheduleGroups.insert(group.key)
                                        }
                                    }
                                } label: {
                                    HStack(spacing: VSpacing.xs) {
                                        HStack(spacing: 2) {
                                            VIconView(.chevronRight, size: 10)
                                                .foregroundColor(VColor.contentTertiary)
                                                .rotationEffect(.degrees(isGroupExpanded ? 90 : 0))
                                                .animation(VAnimation.fast, value: isGroupExpanded)
                                            if hasUnread {
                                                Circle()
                                                    .fill(VColor.systemNegativeStrong)
                                                    .frame(width: 6, height: 6)
                                                    .transition(.opacity)
                                            }
                                        }
                                        .frame(height: SidebarLayoutMetrics.iconSlotSize)
                                        Text(group.label)
                                            .font(.system(size: 13))
                                            .foregroundColor(VColor.contentDefault)
                                            .lineLimit(1)
                                            .truncationMode(.tail)
                                        Text("\(group.conversations.count)")
                                            .font(.system(size: 10, weight: .medium))
                                            .foregroundColor(VColor.contentTertiary)
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

                                // Expanded child rows
                                if isGroupExpanded {
                                    ForEach(group.conversations) { conversation in
                                        SidebarConversationItem(
                                            conversation: conversation,
                                            conversationManager: conversationManager,
                                            windowState: windowState,
                                            sidebar: sidebar,
                                            selectConversation: { selectConversation(conversation) }
                                        )
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
                                    }
                                }

                                // Drop target on the group header so collapsed groups accept drops
                                // (only from conversations within the same schedule group).
                                if !isGroupExpanded {
                                    Color.clear
                                        .frame(height: 0)
                                        .onDrop(of: [.plainText], delegate: ScheduleGroupHeaderDropDelegate(
                                            group: group,
                                            sidebar: sidebar,
                                            conversationManager: conversationManager
                                        ))
                                }
                            }
                        }

                        if scheduleConversationGroups.count > 3 {
                            HStack {
                                VButton(
                                    label: sidebar.showAllScheduleConversations ? "Show less" : "Show more",
                                    style: .ghost,
                                    size: .compact
                                ) {
                                    withAnimation(VAnimation.fast) { sidebar.showAllScheduleConversations.toggle() }
                                }
                                Spacer()
                            }
                            .padding(.leading, VSpacing.xs + SidebarLayoutMetrics.iconSlotSize + VSpacing.xs - VSpacing.sm)
                            .padding(.top, VSpacing.sm)
                            .padding(.bottom, VSpacing.xs)
                        }
                    }
                }
            }
            .scrollIndicators(.never)

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

            SidebarNavRow(icon: VIcon.brain.rawValue, label: "Intelligence", isActive: windowState.selection == .panel(.intelligence), isExpanded: false) {
                windowState.showPanel(.intelligence)
            }
            SidebarNavRow(icon: VIcon.layoutGrid.rawValue, label: "Library", isActive: windowState.selection == .panel(.apps), isExpanded: false) {
                windowState.showPanel(.apps)
            }
            sidebarSectionDivider()

            SidebarNavRow(icon: VIcon.squarePen.rawValue, label: "New Chat", isActive: false, isExpanded: false) {
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
                            .foregroundColor(VColor.primaryBase)
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
                .background(GeometryReader { proxy in
                    Color.clear.onAppear {
                        conversationSwitcherTriggerFrame = proxy.frame(in: .named("coreLayout"))
                    }
                    .onChange(of: proxy.frame(in: .named("coreLayout"))) { _, newFrame in
                        conversationSwitcherTriggerFrame = newFrame
                    }
                })
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
        VColor.surfaceBase
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
