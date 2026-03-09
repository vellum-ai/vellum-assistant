import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

// MARK: - Sidebar Content

extension MainWindowView {

    func selectThread(_ thread: ThreadModel) {
        if case .appEditing(let appId, _) = windowState.selection {
            windowState.selection = .appEditing(appId: appId, threadId: thread.id)
            threadManager.selectThread(id: thread.id)
        } else {
            windowState.selection = .thread(thread.id)
            threadManager.selectThread(id: thread.id)
        }
    }

    /// Maps a thread's interaction state to a dot color for VThreadIcon.
    func interactionDotColor(for thread: ThreadModel) -> Color? {
        switch threadManager.interactionState(for: thread.id) {
        case .processing: return VColor.accent
        case .waitingForInput: return VColor.warning
        case .error: return VColor.error
        case .idle: return nil
        }
    }

    var regularThreads: [ThreadModel] {
        threadManager.visibleThreads.filter { !$0.isScheduleThread }
    }

    var scheduleThreads: [ThreadModel] {
        threadManager.visibleThreads.filter { $0.isScheduleThread }
    }

    var displayedThreads: [ThreadModel] {
        let all = regularThreads
        return sidebar.showAllThreads ? all : Array(all.prefix(5))
    }

    var displayedScheduleThreads: [ThreadModel] {
        let all = scheduleThreads
        return sidebar.showAllScheduleThreads ? all : Array(all.prefix(3))
    }

    /// Groups schedule threads by their scheduleJobId.
    /// Threads without a scheduleJobId are placed in individual groups keyed by their session ID.
    var scheduleThreadGroups: [(key: String, label: String, threads: [ThreadModel])] {
        var grouped: [String: [ThreadModel]] = [:]
        var order: [String] = []
        for thread in scheduleThreads {
            let key = thread.scheduleJobId ?? thread.sessionId ?? thread.id.uuidString
            if grouped[key] == nil {
                order.append(key)
            }
            grouped[key, default: []].append(thread)
        }
        return order.compactMap { key in
            guard let threads = grouped[key], let first = threads.first else { return nil }
            // Use the schedule title prefix (before the colon) as the group label,
            // or fall back to the full title when there's no colon.
            let label: String
            if threads.count > 1 {
                let base = first.title
                if let colonRange = base.range(of: ":") {
                    label = String(base[base.startIndex..<colonRange.lowerBound])
                } else {
                    label = base
                }
            } else {
                label = first.title
            }
            return (key: key, label: label, threads: threads)
        }
    }

    var displayedScheduleGroups: [(key: String, label: String, threads: [ThreadModel])] {
        let all = scheduleThreadGroups
        if sidebar.showAllScheduleThreads { return all }
        // Auto-expand if any hidden group has unread threads.
        let visible = Array(all.prefix(3))
        let hidden = all.dropFirst(3)
        if hidden.contains(where: { group in
            group.threads.contains(where: { $0.hasUnseenLatestAssistantMessage })
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
        .padding(.horizontal, VSpacing.xs)
        .padding(.top, VSpacing.md)
        .padding(.bottom, sidebarExpanded ? VSpacing.md : VSpacing.sm)
        .frame(width: sidebarExpanded ? sidebarExpandedWidth : sidebarCollapsedWidth, alignment: .leading)
        .background(adaptiveColor(light: Moss._50, dark: Moss._950))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .clipped()
        .alert("Rename Thread", isPresented: Binding(
            get: { sidebar.renamingThreadId != nil },
            set: { if !$0 { sidebar.renamingThreadId = nil } }
        )) {
            TextField("Title", text: Binding(
                get: { sidebar.renameText },
                set: { sidebar.renameText = $0 }
            ))
            Button("Cancel", role: .cancel) { sidebar.renamingThreadId = nil }
            Button("Save") {
                if let id = sidebar.renamingThreadId {
                    threadManager.renameThread(id: id, title: sidebar.renameText)
                }
                sidebar.renamingThreadId = nil
            }
        } message: {
            Text("Enter a new name for this thread")
        }
    }

    // MARK: - Pinned App Helpers

    /// A pinned app row — delegates layout to `SidebarPrimaryRow` for both
    /// expanded and collapsed modes, then adds app-specific context menu and drag.
    @ViewBuilder
    func sidebarPinnedAppRow(_ app: AppListManager.AppItem, isExpanded: Bool = true) -> some View {
        SidebarPrimaryRow(
            icon: app.sfSymbol ?? "square.grid.2x2",
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
            Spacer().frame(height: 0)

            // MARK: Pinned Apps (above nav items)
            if !appListManager.pinnedApps.isEmpty {
                VStack(spacing: SidebarLayoutMetrics.listRowGap) {
                    ForEach(appListManager.pinnedApps) { app in
                        sidebarPinnedAppRow(app)
                    }
                }
                .drawingGroup() // Isolate into Metal layer to prevent re-renders from sibling hover

                sidebarSectionDivider(isExpanded: true)
            }

            // MARK: Nav Items (fixed)
            SidebarNavRow(icon: VIcon.brain.rawValue, label: "Intelligence", isActive: windowState.selection == .panel(.intelligence)) {
                windowState.togglePanel(.intelligence)
            }
            SidebarNavRow(icon: VIcon.layoutGrid.rawValue, label: "Things", isActive: windowState.selection == .panel(.apps)) {
                windowState.showAppsPanel()
            }

            // Divider between nav items and threads
            sidebarSectionDivider(isExpanded: true)

            // MARK: Threads (scrollable)
            SidebarThreadsHeader(
                hasUnseenThreads: threadManager.unseenVisibleConversationCount > 0,
                isLoading: showDaemonLoading,
                onMarkAllSeen: {
                    let markedIds = threadManager.markAllThreadsSeen()
                    guard !markedIds.isEmpty else { return }
                    let count = markedIds.count
                    let toastId = windowState.showToast(
                        message: "Marked \(count) thread\(count == 1 ? "" : "s") as seen",
                        style: .success,
                        primaryAction: VToastAction(label: "Undo") {
                            threadManager.restoreUnseen(threadIds: markedIds)
                            windowState.dismissToast()
                        },
                        onDismiss: {
                            threadManager.commitPendingSeenSignals()
                        }
                    )
                    threadManager.schedulePendingSeenSignals {
                        windowState.dismissToast(id: toastId)
                    }
                },
                onNewThread: {
                    windowState.selection = nil
                    threadManager.enterDraftMode()
                }
            )

            ScrollView {
                VStack(spacing: 0) {
                    if showDaemonLoading && displayedThreads.isEmpty {
                        DaemonLoadingThreadsSkeleton()
                    }

                    ForEach(displayedThreads) { thread in
                        SidebarThreadItem(
                            thread: thread,
                            threadManager: threadManager,
                            windowState: windowState,
                            sidebar: sidebar,
                            selectThread: { selectThread(thread) }
                        )
                            .padding(.bottom, SidebarLayoutMetrics.listRowGap)
                            .overlay(alignment: sidebar.dropIndicatorAtBottom ? .bottom : .top) {
                                if sidebar.dropTargetThreadId == thread.id {
                                    Rectangle()
                                        .fill(adaptiveColor(light: Forest._500, dark: Forest._400))
                                        .frame(height: 2)
                                        .transition(.opacity)
                                }
                            }
                            .dropDestination(for: String.self) { items, _ in
                                sidebar.dropTargetThreadId = nil
                                sidebar.draggingThreadId = nil
                                guard let droppedId = items.first,
                                      let sourceUUID = UUID(uuidString: droppedId),
                                      sourceUUID != thread.id else { return false }
                                return threadManager.moveThread(sourceId: sourceUUID, targetId: thread.id)
                            } isTargeted: { isTargeted in
                                if isTargeted && thread.id != sidebar.draggingThreadId {
                                    sidebar.dropTargetThreadId = thread.id
                                    if let dragId = sidebar.draggingThreadId {
                                        let visible = threadManager.visibleThreads
                                        let sIdx = visible.firstIndex(where: { $0.id == dragId }) ?? 0
                                        let tIdx = visible.firstIndex(where: { $0.id == thread.id }) ?? 0
                                        sidebar.dropIndicatorAtBottom = sIdx < tIdx
                                    }
                                } else if !isTargeted && sidebar.dropTargetThreadId == thread.id {
                                    sidebar.dropTargetThreadId = nil
                                }
                            }
                    }

                    if regularThreads.count > 5 {
                        Button {
                            withAnimation(VAnimation.standard) { sidebar.showAllThreads.toggle() }
                        } label: {
                            Text(sidebar.showAllThreads ? "Show less" : "Show more")
                                .font(VFont.caption)
                                .foregroundColor(adaptiveColor(light: Forest._600, dark: Forest._400))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.leading, VSpacing.sm + VSpacing.xs + 20 + VSpacing.xs)
                                .padding(.top, VSpacing.sm)
                                .padding(.bottom, VSpacing.xs)
                        }
                        .buttonStyle(.plain)
                        .pointerCursor()
                    }

                    if !scheduleThreads.isEmpty {
                        // Scheduled threads section
                        HStack {
                            Text("Scheduled")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                            Spacer()
                        }
                        .padding(.leading, SidebarLayoutMetrics.iconSlotSize)
                        .padding(.trailing, VSpacing.md)
                        .padding(.top, SidebarLayoutMetrics.scheduledHeaderTopGap)
                        .padding(.bottom, SidebarLayoutMetrics.scheduledHeaderBottomGap)

                        ForEach(displayedScheduleGroups, id: \.key) { group in
                            if group.threads.count == 1, let thread = group.threads.first {
                                // Single-thread group: render inline without a disclosure wrapper
                                SidebarThreadItem(
                                    thread: thread,
                                    threadManager: threadManager,
                                    windowState: windowState,
                                    sidebar: sidebar,
                                    selectThread: { selectThread(thread) }
                                )
                                    .padding(.bottom, SidebarLayoutMetrics.listRowGap)
                                    .overlay(alignment: sidebar.dropIndicatorAtBottom ? .bottom : .top) {
                                        if sidebar.dropTargetThreadId == thread.id {
                                            Rectangle()
                                                .fill(adaptiveColor(light: Forest._500, dark: Forest._400))
                                                .frame(height: 2)
                                                .transition(.opacity)
                                        }
                                    }
                                    .onDrop(of: [.plainText], delegate: ScheduleReorderDropDelegate(
                                        targetThread: thread,
                                        sidebar: sidebar,
                                        threadManager: threadManager
                                    ))
                            } else {
                                // Multi-thread group: custom disclosure styled like a nav row
                                let isGroupExpanded = sidebar.expandedScheduleGroups.contains(group.key)
                                let hasUnread = !isGroupExpanded &&
                                    group.threads.contains(where: { $0.hasUnseenLatestAssistantMessage })

                                // Header row — chevron in icon slot, label + count badge
                                Button {
                                    withAnimation(VAnimation.standard) {
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
                                                .foregroundColor(VColor.textMuted)
                                                .rotationEffect(.degrees(isGroupExpanded ? 90 : 0))
                                                .animation(VAnimation.fast, value: isGroupExpanded)
                                            if hasUnread {
                                                Circle()
                                                    .fill(Color(hex: 0xE86B40))
                                                    .frame(width: 6, height: 6)
                                                    .transition(.opacity)
                                            }
                                        }
                                        .frame(height: SidebarLayoutMetrics.iconSlotSize)
                                        Text(group.label)
                                            .font(.system(size: 13))
                                            .foregroundColor(VColor.textPrimary)
                                            .lineLimit(1)
                                            .truncationMode(.tail)
                                        Text("\(group.threads.count)")
                                            .font(.system(size: 10, weight: .medium))
                                            .foregroundColor(VColor.textMuted)
                                            .padding(.horizontal, 6)
                                            .padding(.vertical, 2)
                                            .background(
                                                Capsule()
                                                    .fill(VColor.textMuted.opacity(0.12))
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
                                    ForEach(group.threads) { thread in
                                        SidebarThreadItem(
                                            thread: thread,
                                            threadManager: threadManager,
                                            windowState: windowState,
                                            sidebar: sidebar,
                                            selectThread: { selectThread(thread) }
                                        )
                                            .padding(.bottom, SidebarLayoutMetrics.listRowGap)
                                            .overlay(alignment: sidebar.dropIndicatorAtBottom ? .bottom : .top) {
                                                if sidebar.dropTargetThreadId == thread.id {
                                                    Rectangle()
                                                        .fill(adaptiveColor(light: Forest._500, dark: Forest._400))
                                                        .frame(height: 2)
                                                        .transition(.opacity)
                                                }
                                            }
                                            .onDrop(of: [.plainText], delegate: ScheduleReorderDropDelegate(
                                                targetThread: thread,
                                                sidebar: sidebar,
                                                threadManager: threadManager
                                            ))
                                    }
                                }

                                // Drop target on the group header so collapsed groups accept drops
                                // (only from threads within the same schedule group).
                                if !isGroupExpanded {
                                    Color.clear
                                        .frame(height: 0)
                                        .onDrop(of: [.plainText], delegate: ScheduleGroupHeaderDropDelegate(
                                            group: group,
                                            sidebar: sidebar,
                                            threadManager: threadManager
                                        ))
                                }
                            }
                        }

                        if scheduleThreadGroups.count > 3 {
                            Button {
                                withAnimation(VAnimation.standard) { sidebar.showAllScheduleThreads.toggle() }
                            } label: {
                                Text(sidebar.showAllScheduleThreads ? "Show less" : "Show more")
                                    .font(VFont.caption)
                                    .foregroundColor(adaptiveColor(light: Forest._600, dark: Forest._400))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.leading, VSpacing.sm + VSpacing.xs + 20 + VSpacing.xs)
                                    .padding(.top, VSpacing.sm)
                                    .padding(.bottom, VSpacing.xs)
                            }
                            .buttonStyle(.plain)
                            .pointerCursor()
                        }
                    }
                }
            }
            .scrollIndicators(.never)

            Spacer(minLength: VSpacing.sm)

            sidebarSectionDivider(isExpanded: true)

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
            Spacer().frame(height: 0)

            // MARK: Pinned Apps (collapsed)
            if !appListManager.pinnedApps.isEmpty {
                VStack(spacing: SidebarLayoutMetrics.listRowGap) {
                    ForEach(appListManager.pinnedApps) { app in
                        sidebarPinnedAppRow(app, isExpanded: false)
                    }
                }
                .drawingGroup() // Isolate into Metal layer to prevent re-renders from sibling hover

                sidebarSectionDivider(isExpanded: false)
            }

            SidebarNavRow(icon: VIcon.brain.rawValue, label: "Intelligence", isActive: windowState.selection == .panel(.intelligence), isExpanded: false) {
                windowState.togglePanel(.intelligence)
            }
            SidebarNavRow(icon: VIcon.layoutGrid.rawValue, label: "Things", isActive: windowState.selection == .panel(.apps), isExpanded: false) {
                windowState.showAppsPanel()
            }

            sidebarSectionDivider(isExpanded: false)

            SidebarNavRow(icon: VIcon.squarePen.rawValue, label: "New Chat", isActive: false, isExpanded: false) {
                windowState.selection = nil
                threadManager.enterDraftMode()
            }

            // MARK: Thread Section (collapsed)
            let switcher = CollapsedThreadSwitcherPresentation(
                regularThreads: regularThreads,
                activeThreadId: threadManager.activeThreadId
            )
            if switcher.showsSwitcher {
                Button {
                    showThreadSwitcher.toggle()
                } label: {
                    ZStack(alignment: .bottomTrailing) {
                        Text(switcher.badgeText)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(adaptiveColor(light: Color(hex: 0x537D53), dark: Forest._400))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, SidebarLayoutMetrics.rowVerticalPadding)
                            .frame(minHeight: SidebarLayoutMetrics.rowMinHeight)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.md)
                                    .fill(windowState.isShowingChat && threadManager.activeThread != nil
                                        ? VColor.navActive
                                        : VColor.navHover)
                            )

                        if switcher.switchTargets.contains(where: { $0.hasUnseenLatestAssistantMessage }) {
                            Circle()
                                .fill(Color(hex: 0xE86B40))
                                .frame(width: 8, height: 8)
                                .offset(x: 4, y: 4)
                        }
                    }
                }
                .buttonStyle(.plain)
                .padding(.horizontal, VSpacing.xs)
                .accessibilityLabel(switcher.accessibilityLabel)
                .accessibilityValue(switcher.accessibilityValue)
                .onDisappear {
                    showThreadSwitcher = false
                }
                .pointerCursor()
                .background(GeometryReader { proxy in
                    Color.clear.onAppear {
                        threadSwitcherTriggerFrame = proxy.frame(in: .named("coreLayout"))
                    }
                    .onChange(of: proxy.frame(in: .named("coreLayout"))) { _, newFrame in
                        threadSwitcherTriggerFrame = newFrame
                    }
                })
            }

            Spacer()

            sidebarSectionDivider(isExpanded: false)

            PreferencesRow(
                isActive: sidebar.showPreferencesDrawer,
                isExpanded: false,
                onToggle: {
                    withAnimation(VAnimation.snappy) {
                        sidebar.showPreferencesDrawer.toggle()
                    }
                }
            )

            Spacer().frame(height: 0)
        }
    }

    // MARK: - Section Divider

    /// Uniform section divider using canonical metrics.
    /// Horizontal inset adapts to expanded/collapsed; vertical rhythm is always compact.
    @ViewBuilder
    func sidebarSectionDivider(isExpanded: Bool) -> some View {
        VColor.divider
            .frame(height: 1)
            .padding(.horizontal, isExpanded
                ? SidebarLayoutMetrics.dividerHorizontalPaddingExpanded
                : SidebarLayoutMetrics.dividerHorizontalPaddingCollapsed)
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
        try? daemonClient.sendAppOpen(appId: app.id)
    }
}
