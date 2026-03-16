#if canImport(UIKit)
import SwiftUI
import UIKit
import VellumAssistantShared

func sortThreadsForDisplay(
    _ threads: [IOSThread],
    isConnectedMode: Bool
) -> [IOSThread] {
    guard isConnectedMode else { return threads }

    return threads.sorted { a, b in
        if a.isPinned && b.isPinned {
            if a.displayOrder == nil && b.displayOrder == nil {
                return a.lastActivityAt > b.lastActivityAt
            }
            if a.displayOrder == nil { return false }
            if b.displayOrder == nil { return true }
            return a.displayOrder! < b.displayOrder!
        }
        if a.isPinned { return true }
        if b.isPinned { return false }
        if a.displayOrder == nil && b.displayOrder == nil {
            return a.lastActivityAt > b.lastActivityAt
        }
        if a.displayOrder == nil { return true }
        if b.displayOrder == nil { return false }
        return a.displayOrder! < b.displayOrder!
    }
}

// MARK: - Tab Entry Point

/// The tab-level Chats entry point. Switches between connected and disconnected
/// states so ThreadListView only mounts when a live DaemonClient is available.
struct ChatsTabView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @ObservedObject var store: IOSThreadStore
    var onConnectTapped: (() -> Void)?

    var body: some View {
        if clientProvider.isConnected {
            ThreadListView(store: store)
        } else {
            ChatsDisconnectedView(onConnectTapped: onConnectTapped)
        }
    }
}

// MARK: - Disconnected State

struct ChatsDisconnectedView: View {
    var onConnectTapped: (() -> Void)?

    var body: some View {
        NavigationStack {
            VStack(spacing: VSpacing.lg) {
                VIconView(.messageSquare, size: 48)
                    .foregroundColor(VColor.contentTertiary)
                    .accessibilityHidden(true)
                Text("Chats Require Connection")
                    .font(VFont.title)
                    .foregroundColor(VColor.contentDefault)
                Text("Connect to your Assistant to start a conversation.")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, VSpacing.xl)
                if onConnectTapped != nil {
                    Button {
                        onConnectTapped?()
                    } label: {
                        Text("Go to Settings")
                    }
                    .buttonStyle(.bordered)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle("Chats")
        }
    }
}

// MARK: - ThreadListView

struct ThreadListView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @ObservedObject var store: IOSThreadStore
    @State private var navigationPath: [UUID] = []
    @State private var selectedThreadId: UUID?
    @State private var searchText: String = ""
    @State private var renamingThreadId: UUID?
    @State private var renameText: String = ""
    @State private var showArchived: Bool = false

    private var activeThreads: [IOSThread] {
        // Exclude private threads — they are managed separately via the Private Threads
        // settings panel and must not appear in the main chat list.
        sortThreadsForDisplay(
            store.threads.filter { !$0.isArchived && !$0.isPrivate },
            isConnectedMode: store.isConnectedMode
        )
    }

    /// Active threads that are NOT from a schedule.
    private var regularThreads: [IOSThread] {
        activeThreads.filter { !$0.isScheduleThread }
    }

    /// Active threads created by a schedule trigger (including one-shot/reminders).
    private var scheduleThreads: [IOSThread] {
        activeThreads.filter { $0.isScheduleThread }
    }

    /// Groups schedule threads by their scheduleJobId for collapsible display.
    private var scheduleThreadGroups: [(key: String, label: String, threads: [IOSThread])] {
        var grouped: [String: [IOSThread]] = [:]
        var order: [String] = []
        for thread in filteredScheduleThreads {
            let key = thread.scheduleJobId ?? thread.conversationId ?? thread.id.uuidString
            if grouped[key] == nil {
                order.append(key)
            }
            grouped[key, default: []].append(thread)
        }
        return order.compactMap { key in
            guard let threads = grouped[key], let first = threads.first else { return nil }
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

    private var archivedThreads: [IOSThread] {
        sortThreadsForDisplay(
            store.threads.filter { $0.isArchived && !$0.isPrivate },
            isConnectedMode: store.isConnectedMode
        )
    }

    private var filteredActiveThreads: [IOSThread] {
        guard !searchText.isEmpty else { return activeThreads }
        return activeThreads.filter { $0.title.localizedCaseInsensitiveContains(searchText) }
    }

    private var filteredRegularThreads: [IOSThread] {
        guard !searchText.isEmpty else { return regularThreads }
        return regularThreads.filter { $0.title.localizedCaseInsensitiveContains(searchText) }
    }

    private var filteredScheduleThreads: [IOSThread] {
        guard !searchText.isEmpty else { return scheduleThreads }
        return scheduleThreads.filter { $0.title.localizedCaseInsensitiveContains(searchText) }
    }

    private var filteredArchivedThreads: [IOSThread] {
        guard !searchText.isEmpty else { return archivedThreads }
        return archivedThreads.filter { $0.title.localizedCaseInsensitiveContains(searchText) }
    }

    var body: some View {
        if store.isLoadingInitialThreads {
            loadingView
        } else if horizontalSizeClass == .regular {
            NavigationSplitView {
                threadList
            } detail: {
                detailView
            }
        } else {
            NavigationStack(path: $navigationPath) {
                threadList
                    .navigationDestination(for: UUID.self) { threadId in
                        threadDetailContent(for: threadId)
                    }
            }
        }
    }

    private var loadingView: some View {
        VStack(spacing: VSpacing.md) {
            ProgressView()
            Text("Loading chats\u{2026}")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle("Chats")
    }

    // MARK: - Detail Views

    @ViewBuilder
    private func threadDetailContent(for threadId: UUID) -> some View {
        if let thread = store.threads.first(where: { $0.id == threadId }) {
            ThreadChatView(
                viewModel: store.viewModel(for: threadId),
                threadTitle: thread.title
            )
            .onAppear {
                store.loadHistoryIfNeeded(for: threadId)
                store.markConversationSeenIfNeeded(threadId: threadId, isExplicitOpen: true)
                store.viewModel(for: threadId).consumeDeepLinkIfNeeded()
            }
            .onChange(of: thread.hasUnseenLatestAssistantMessage) { _, hasUnseen in
                guard hasUnseen else { return }
                // The detail view can stay mounted across reconnects, so re-run
                // the explicit seen path when the visible thread flips unread.
                store.markConversationSeenIfNeeded(threadId: threadId)
            }
            .onOpenURL { _ in
                DispatchQueue.main.async {
                    store.viewModel(for: threadId).consumeDeepLinkIfNeeded()
                }
            }
        } else {
            Text("Select a chat")
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var detailView: some View {
        if let selectedId = selectedThreadId {
            threadDetailContent(for: selectedId)
        } else {
            Text("Select a chat")
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Thread List

    private func archiveActiveThread(_ thread: IOSThread) {
        store.archiveThread(thread)
        if horizontalSizeClass == .regular && selectedThreadId == thread.id {
            selectedThreadId = activeThreads.first?.id
        }
    }

    private func beginRenaming(_ thread: IOSThread) {
        renamingThreadId = thread.id
        renameText = thread.title
    }

    private func canToggleThreadPin(_ thread: IOSThread) -> Bool {
        store.isConnectedMode && thread.conversationId != nil
    }

    private func canMarkThreadUnread(_ thread: IOSThread) -> Bool {
        store.isConnectedMode &&
            thread.conversationId != nil &&
            !thread.hasUnseenLatestAssistantMessage &&
            thread.latestAssistantMessageAt != nil
    }

    private func scheduleGroupHasUnread(_ group: (key: String, label: String, threads: [IOSThread])) -> Bool {
        store.isConnectedMode && group.threads.contains(where: \.hasUnseenLatestAssistantMessage)
    }

    private func scheduleGroupHasPinned(_ group: (key: String, label: String, threads: [IOSThread])) -> Bool {
        store.isConnectedMode && group.threads.contains(where: \.isPinned)
    }

    @ViewBuilder
    private func connectedThreadContextMenu(_ thread: IOSThread) -> some View {
        if canToggleThreadPin(thread) {
            Button {
                if thread.isPinned {
                    store.unpinThread(thread)
                } else {
                    store.pinThread(thread)
                }
            } label: {
                Label {
                    Text(thread.isPinned ? "Unpin thread" : "Pin thread")
                } icon: {
                    VIconView(thread.isPinned ? .pinOff : .pin, size: 14)
                }
            }
        }

        Button {
            beginRenaming(thread)
        } label: {
            Label { Text("Rename thread") } icon: { VIconView(.pencil, size: 14) }
        }

        Button {
            archiveActiveThread(thread)
        } label: {
            Label { Text("Archive thread") } icon: { VIconView(.archive, size: 14) }
        }

        Button {
            store.markThreadUnread(thread)
        } label: {
            Label { Text("Mark as unread") } icon: { VIconView(.circle, size: 14) }
        }
        .disabled(!canMarkThreadUnread(thread))
    }

    @ViewBuilder
    private func maybeConnectedContextMenu<Content: View>(
        thread: IOSThread,
        @ViewBuilder content: () -> Content
    ) -> some View {
        if store.isConnectedMode {
            content()
                .contextMenu {
                    connectedThreadContextMenu(thread)
                }
        } else {
            content()
        }
    }

    @ViewBuilder
    private func connectedScheduleGroupContextMenu(
        _ group: (key: String, label: String, threads: [IOSThread])
    ) -> some View {
        ForEach(group.threads) { thread in
            Menu {
                connectedThreadContextMenu(thread)
            } label: {
                Label {
                    Text(thread.title)
                } icon: {
                    VIconView(.messageCircle, size: 14)
                }
            }
        }
    }

    @ViewBuilder
    private func maybeConnectedScheduleGroupContextMenu<Content: View>(
        group: (key: String, label: String, threads: [IOSThread]),
        @ViewBuilder content: () -> Content
    ) -> some View {
        if store.isConnectedMode {
            content()
                .contextMenu {
                    connectedScheduleGroupContextMenu(group)
                }
        } else {
            content()
        }
    }

    private var threadList: some View {
        List(selection: horizontalSizeClass == .regular ? $selectedThreadId : nil) {
            // Regular (non-schedule) threads
            ForEach(filteredRegularThreads) { thread in
                maybeConnectedContextMenu(thread: thread) {
                    NavigationLink(value: thread.id) {
                        threadRow(thread)
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            store.deleteThread(thread)
                            if horizontalSizeClass == .regular && selectedThreadId == thread.id {
                                selectedThreadId = activeThreads.first?.id
                            }
                        } label: {
                            Label { Text("Delete") } icon: { VIconView(.trash, size: 14) }
                        }
                        Button {
                            archiveActiveThread(thread)
                        } label: {
                            Label { Text("Archive") } icon: { VIconView(.archive, size: 14) }
                        }
                        .tint(VColor.systemNegativeHover)
                    }
                    .swipeActions(edge: .leading) {
                        Button {
                            beginRenaming(thread)
                        } label: {
                            Label { Text("Rename") } icon: { VIconView(.pencil, size: 14) }
                        }
                        .tint(.blue) // Intentional: system blue for non-destructive swipe actions
                    }
                }
            }

            // Scheduled threads grouped by scheduleJobId
            if !filteredScheduleThreads.isEmpty {
                scheduledSection
            }

            if !archivedThreads.isEmpty {
                Section {
                    DisclosureGroup("Archived", isExpanded: $showArchived) {
                        ForEach(filteredArchivedThreads) { thread in
                            NavigationLink(value: thread.id) {
                                threadRow(thread)
                            }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    store.deleteThread(thread)
                                    if horizontalSizeClass == .regular && selectedThreadId == thread.id {
                                        selectedThreadId = activeThreads.first?.id
                                    }
                                } label: {
                                    Label { Text("Delete") } icon: { VIconView(.trash, size: 14) }
                                }
                                Button {
                                    store.unarchiveThread(thread)
                                } label: {
                                    Label { Text("Unarchive") } icon: { VIconView(.inbox, size: 14) }
                                }
                                .tint(.blue) // Intentional: system blue for non-destructive swipe actions
                            }
                        }
                    }
                }
            }

            // Load-more trigger: appears when the daemon has additional sessions beyond
            // the current page. Becomes visible as the user scrolls toward the bottom.
            if store.hasMoreThreads || store.isLoadingMoreThreads {
                HStack {
                    Spacer()
                    if store.isLoadingMoreThreads {
                        VLoadingIndicator(size: 18)
                    } else {
                        // Invisible sentinel: triggers the next page fetch on appear.
                        Color.clear.frame(height: 1)
                    }
                    Spacer()
                }
                .listRowSeparator(.hidden)
                .onAppear {
                    store.loadMoreThreads()
                }
            }
        }
        .searchable(text: $searchText, prompt: "Search chats")
        .navigationTitle("Chats")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    let thread = store.newThread()
                    if horizontalSizeClass == .regular {
                        selectedThreadId = thread.id
                    } else {
                        navigationPath = [thread.id]
                    }
                } label: {
                    VIconView(.squarePen, size: 20)
}
            }
        }
        .alert("Rename Chat", isPresented: Binding(
            get: { renamingThreadId != nil },
            set: { if !$0 { renamingThreadId = nil } }
        )) {
            TextField("Title", text: $renameText)
            Button("Cancel", role: .cancel) { renamingThreadId = nil }
            Button("Save") {
                if let id = renamingThreadId, !renameText.isEmpty {
                    store.updateTitle(renameText, for: id)
                }
                renamingThreadId = nil
            }
        } message: {
            Text("Enter a new name for this chat")
        }
    }

    // MARK: - Scheduled Section

    private var scheduledSection: some View {
        Section("Scheduled") {
            ForEach(scheduleThreadGroups, id: \.key) { group in
                scheduleGroupRow(group)
            }
        }
    }

    @ViewBuilder
    private func scheduleGroupRow(_ group: (key: String, label: String, threads: [IOSThread])) -> some View {
        if group.threads.count == 1, let thread = group.threads.first {
            // Single-thread group: render inline
            maybeConnectedContextMenu(thread: thread) {
                NavigationLink(value: thread.id) {
                    threadRow(thread)
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        store.deleteThread(thread)
                        if horizontalSizeClass == .regular && selectedThreadId == thread.id {
                            selectedThreadId = activeThreads.first?.id
                        }
                    } label: {
                        Label { Text("Delete") } icon: { VIconView(.trash, size: 14) }
                    }
                    Button {
                        archiveActiveThread(thread)
                    } label: {
                        Label { Text("Archive") } icon: { VIconView(.archive, size: 14) }
                    }
                    .tint(VColor.systemNegativeHover)
                }
                .swipeActions(edge: .leading) {
                    Button {
                        beginRenaming(thread)
                    } label: {
                        Label { Text("Rename") } icon: { VIconView(.pencil, size: 14) }
                    }
                    .tint(.blue) // Intentional: system blue for non-destructive swipe actions
                }
            }
        } else {
            // Multi-thread group: DisclosureGroup with fully-tappable label.
            // Context menu is on the label only so tap-to-expand (on the disclosure chevron)
            // and long-press-for-menu remain distinct gestures.
            DisclosureGroup {
                ForEach(group.threads) { thread in
                    maybeConnectedContextMenu(thread: thread) {
                        NavigationLink(value: thread.id) {
                            threadRow(thread)
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                store.deleteThread(thread)
                                if horizontalSizeClass == .regular && selectedThreadId == thread.id {
                                    selectedThreadId = activeThreads.first?.id
                                }
                            } label: {
                                Label { Text("Delete") } icon: { VIconView(.trash, size: 14) }
                            }
                            Button {
                                archiveActiveThread(thread)
                            } label: {
                                Label { Text("Archive") } icon: { VIconView(.archive, size: 14) }
                            }
                            .tint(VColor.systemNegativeHover)
                        }
                        .swipeActions(edge: .leading) {
                            Button {
                                beginRenaming(thread)
                            } label: {
                                Label { Text("Rename") } icon: { VIconView(.pencil, size: 14) }
                            }
                            .tint(.blue) // Intentional: system blue for non-destructive swipe actions
                        }
                    }
                }
            } label: {
                maybeConnectedScheduleGroupContextMenu(group: group) {
                    HStack(spacing: 8) {
                        VIconView(.messageCircle, size: 12)
                            .foregroundStyle(.secondary)
                        Text(group.label)
                            .fontWeight(scheduleGroupHasUnread(group) ? .semibold : .regular)
                            .lineLimit(1)
                        if scheduleGroupHasPinned(group) {
                            VIconView(.pin, size: 10)
                                .foregroundColor(VColor.primaryBase)
                                .accessibilityLabel("Pinned")
                        }
                        if scheduleGroupHasUnread(group) {
                            VBadge(style: .dot, color: VColor.systemNegativeHover)
                                .accessibilityLabel("Unread")
                        }
                        Text("\(group.threads.count)")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(
                                Capsule()
                                    .fill(Color.secondary.opacity(0.12))
                            )
                        Spacer()
                    }
                    .contentShape(Rectangle())
                }
            }
        }
    }

    // MARK: - Thread Row

    private func threadRow(_ thread: IOSThread) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                VIconView(.messageCircle, size: 12)
                    .foregroundStyle(.secondary)
                Text(thread.title)
                    .fontWeight(
                        store.isConnectedMode && thread.hasUnseenLatestAssistantMessage
                            ? .semibold
                            : .regular
                    )
                    .lineLimit(1)
                if store.isConnectedMode && thread.isPinned {
                    VIconView(.pin, size: 10)
                        .foregroundColor(VColor.primaryBase)
                        .accessibilityLabel("Pinned")
                }
                if store.isConnectedMode && thread.hasUnseenLatestAssistantMessage {
                    VBadge(style: .dot, color: VColor.systemNegativeHover)
                        .accessibilityLabel("Unread")
                }
                Spacer()
                Text(relativeDate(thread.lastActivityAt))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            if let preview = store.lastMessagePreview(for: thread.id) {
                Text(preview)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    private func relativeDate(_ date: Date) -> String {
        DateFormatting.relativeTimestamp(date)
    }
}

// MARK: - ThreadChatView

/// Thin wrapper around ChatContentView for a thread-owned ChatViewModel.
struct ThreadChatView: View {
    @ObservedObject var viewModel: ChatViewModel
    var threadTitle: String?

    @EnvironmentObject var clientProvider: ClientProvider
    @AppStorage(UserDefaultsKeys.developerModeEnabled) private var developerModeEnabled: Bool = false
    @State private var showCopiedConfirmation = false
    @State private var showShareSheet = false
    @State private var shareMarkdown: String = ""
    @State private var showDebugPanel = false

    var body: some View {
        ChatContentView(viewModel: viewModel)
            .navigationTitle("Chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if developerModeEnabled {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button {
                            showDebugPanel = true
                        } label: {
                            VIconView(.bug, size: 20)
                                .foregroundColor(VColor.contentTertiary)
                        }
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    exportMenu
                }
            }
            .sheet(isPresented: $showShareSheet) {
                ActivityViewController(activityItems: [shareMarkdown])
            }
            .sheet(isPresented: $showDebugPanel) {
                DebugPanelView(
                    traceStore: clientProvider.traceStore,
                    sessionId: viewModel.conversationId,
                    onClose: { showDebugPanel = false }
                )
            }
    }

    @ViewBuilder
    private var exportMenu: some View {
        let hasTextMessages = viewModel.messages.contains {
            !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }

        Menu {
            Button {
                let markdown = buildMarkdown()
                guard !markdown.isEmpty else { return }
                UIPasteboard.general.string = markdown
                showCopiedConfirmation = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    showCopiedConfirmation = false
                }
            } label: {
                Label {
                    Text(showCopiedConfirmation ? "Copied!" : "Copy as Markdown")
                } icon: {
                    VIconView(showCopiedConfirmation ? .check : .copy, size: 14)
                }
            }

            Button {
                let markdown = buildMarkdown()
                guard !markdown.isEmpty else { return }
                shareMarkdown = markdown
                showShareSheet = true
            } label: {
                Label { Text("Share\u{2026}") } icon: { VIconView(.share, size: 14) }
            }
        } label: {
            VIconView(showCopiedConfirmation ? .check : .share, size: 20)
                .foregroundColor(showCopiedConfirmation ? VColor.systemPositiveStrong : VColor.contentTertiary)
        }
        .disabled(!hasTextMessages)
    }

    private func buildMarkdown() -> String {
        let names = ChatTranscriptFormatter.ParticipantNames(
            assistantName: "Assistant",
            userName: "You"
        )
        return ChatTranscriptFormatter.threadMarkdown(
            messages: viewModel.messages,
            threadTitle: threadTitle,
            participantNames: names
        )
    }
}

#endif
