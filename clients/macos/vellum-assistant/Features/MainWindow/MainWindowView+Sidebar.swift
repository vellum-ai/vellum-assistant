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
        .padding(VSpacing.xs)
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
            SidebarNavRow(icon: "brain.head.profile", label: "Intelligence", isActive: windowState.activePanel == .intelligence) {
                windowState.togglePanel(.intelligence)
            }
            SidebarNavRow(icon: "square.grid.2x2", label: "Things", isActive: windowState.activePanel == .apps) {
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
                                        ZStack {
                                            Image(systemName: "chevron.right")
                                                .font(.system(size: 10, weight: .semibold))
                                                .foregroundColor(VColor.textMuted)
                                                .rotationEffect(.degrees(isGroupExpanded ? 90 : 0))
                                                .animation(VAnimation.fast, value: isGroupExpanded)
                                            if hasUnread {
                                                Circle()
                                                    .fill(Color(hex: 0xE86B40))
                                                    .frame(width: 6, height: 6)
                                                    .offset(x: 7, y: -5)
                                                    .transition(.opacity)
                                            }
                                        }
                                        .frame(width: SidebarLayoutMetrics.iconSlotSize, height: SidebarLayoutMetrics.iconSlotSize)
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

            // Preferences row (fixed)
            PreferencesRow(
                onToggle: {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
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

            SidebarNavRow(icon: "brain.head.profile", label: "Intelligence", isActive: windowState.activePanel == .intelligence, isExpanded: false) {
                windowState.togglePanel(.intelligence)
            }
            SidebarNavRow(icon: "square.grid.2x2", label: "Things", isActive: windowState.activePanel == .apps, isExpanded: false) {
                windowState.showAppsPanel()
            }

            sidebarSectionDivider(isExpanded: false)

            SidebarNavRow(icon: "square.and.pencil", label: "New Chat", isActive: false, isExpanded: false) {
                windowState.selection = nil
                threadManager.enterDraftMode()
            }

            // MARK: Thread Section (collapsed)
            if let activeThread = threadManager.activeThread {
                Button {
                    guard regularThreads.count > 1 else { return }
                    threadSwitcherHoverTask?.cancel()
                    threadSwitcherHoverTask = nil
                    showThreadSwitcher.toggle()
                } label: {
                    ZStack(alignment: .bottomTrailing) {
                        // Active thread icon — SF Symbol chat bubble matching SidebarNavRow style
                        Image(systemName: "ellipsis.message")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(adaptiveColor(light: Color(hex: 0x537D53), dark: Forest._400))
                            .frame(width: 28, height: 28)

                        // Unseen dot overlay (bottom-right) — shows when any thread has unseen messages
                        if regularThreads.contains(where: { $0.hasUnseenLatestAssistantMessage }) {
                            Circle()
                                .fill(Color(hex: 0xE86B40))
                                .frame(width: 8, height: 8)
                                .offset(x: 4, y: 4)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Switch threads: \(activeThread.title)")
                .accessibilityValue(regularThreads.count > 1 ? "\(regularThreads.count) threads" : "")
                .onDisappear {
                    threadSwitcherHoverTask?.cancel()
                    threadSwitcherHoverTask = nil
                    threadSwitcherDismissTask?.cancel()
                    threadSwitcherDismissTask = nil
                    showThreadSwitcher = false
                }
                .if(regularThreads.count > 1) { view in
                    view.pointerCursor()
                }
                .onHover { hovering in
                    guard regularThreads.count > 1 else { return }
                    if hovering {
                        // Cancel any pending dismiss
                        threadSwitcherDismissTask?.cancel()
                        threadSwitcherDismissTask = nil
                        // Start open timer
                        threadSwitcherHoverTask?.cancel()
                        threadSwitcherHoverTask = Task { @MainActor in
                            try? await Task.sleep(for: .milliseconds(300))
                            guard !Task.isCancelled else { return }
                            showThreadSwitcher = true
                        }
                    } else {
                        threadSwitcherHoverTask?.cancel()
                        threadSwitcherHoverTask = nil
                        // Schedule dismiss — gives time to move mouse into the popover
                        if showThreadSwitcher {
                            threadSwitcherDismissTask = Task { @MainActor in
                                try? await Task.sleep(for: .milliseconds(300))
                                guard !Task.isCancelled else { return }
                                showThreadSwitcher = false
                            }
                        }
                    }
                }
                .popover(isPresented: $showThreadSwitcher, arrowEdge: .trailing) {
                    VStack(alignment: .leading, spacing: 0) {
                        // Header
                        Text("\(regularThreads.count) threads")
                            .font(VFont.body)
                            .foregroundColor(VColor.textMuted)
                            .padding(.leading, VSpacing.md)
                            .padding(.trailing, VSpacing.sm)
                            .padding(.top, VSpacing.md)
                            .padding(.bottom, VSpacing.sm)

                        VColor.divider
                            .frame(height: 1)
                            .padding(.horizontal, VSpacing.xs)
                            .padding(.bottom, VSpacing.sm)

                        // Thread list
                        ScrollView {
                            VStack(spacing: 0) {
                                ForEach(regularThreads) { thread in
                                    SidebarThreadItem(
                                        thread: thread,
                                        threadManager: threadManager,
                                        windowState: windowState,
                                        sidebar: sidebar,
                                        selectThread: { selectThread(thread) },
                                        onSelect: { showThreadSwitcher = false }
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
                            }
                        }
                        .frame(maxHeight: 300)
                    }
                    .frame(width: 220)
                    .padding(.bottom, VSpacing.sm)
                    .background(VColor.backgroundSubtle)
                    .onChange(of: threadManager.activeThreadId) { _, _ in
                        showThreadSwitcher = false
                    }
                    .onDisappear {
                        // Clean up hover state when popover dismisses —
                        // onHover(false) may not fire if the view is removed.
                        // Cursor cleanup is handled by PointerCursorModifier.
                        if sidebar.isHoveredThread != nil {
                            sidebar.isHoveredThread = nil
                        }
                        sidebar.threadPendingDeletion = nil
                    }
                    // Hover→pending-deletion invariant is now owned by
                    // SidebarInteractionState.setThreadHover(threadId:hovering:)
                    .onHover { hovering in
                        if hovering {
                            // Mouse entered popover — cancel pending dismiss
                            threadSwitcherDismissTask?.cancel()
                            threadSwitcherDismissTask = nil
                        } else {
                            // Mouse left popover — dismiss after short delay
                            threadSwitcherDismissTask = Task { @MainActor in
                                try? await Task.sleep(for: .milliseconds(300))
                                guard !Task.isCancelled else { return }
                                showThreadSwitcher = false
                            }
                        }
                    }
                }
            }

            Spacer()

            SidebarNavRow(icon: "slider.horizontal.3", label: "Preferences", isActive: false, isExpanded: false) {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
                    sidebar.showPreferencesDrawer.toggle()
                }
            }

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
