#if canImport(UIKit)
import SwiftUI
import UIKit
import VellumAssistantShared

func sortConversationsForDisplay(
    _ conversations: [IOSConversation],
    isConnectedMode: Bool
) -> [IOSConversation] {
    guard isConnectedMode else { return conversations }

    return conversations.sorted { a, b in
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

@MainActor
func makeConversationForkFromMessageAction(
    store: IOSConversationStore,
    conversation: IOSConversation
) -> ((String) -> Void)? {
    guard conversation.conversationId != nil, !conversation.isPrivate else { return nil }
    return makeOnForkFromMessageAction(
        conversationLocalId: conversation.id,
        forkConversationFromMessage: { conversationLocalId, daemonMessageId in
            await store.forkConversation(
                conversationLocalId: conversationLocalId,
                throughDaemonMessageId: daemonMessageId
            )
        }
    )
}

@MainActor
func makeOpenForkParentAction(
    store: IOSConversationStore,
    conversation: IOSConversation
) -> (() -> Void)? {
    guard conversation.forkParent != nil, !conversation.isPrivate else { return nil }
    return {
        Task { @MainActor in
            _ = await store.openForkParent(of: conversation.id)
        }
    }
}

// MARK: - ConversationListView

struct ConversationListView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @EnvironmentObject var clientProvider: ClientProvider
    @ObservedObject var store: IOSConversationStore

    /// Drawer-mode callback: when non-nil, the view renders only its list content
    /// (no NavigationSplitView / NavigationStack wrapper) and row taps fire this
    /// instead of pushing a NavigationLink. Used by `ConversationDrawerView` on
    /// compact size classes where `IOSRootNavigationView` owns the NavigationStack.
    var onSelectConversation: ((UUID) -> Void)?

    /// Invoked when the user taps the Settings entry point in the iPad sidebar
    /// toolbar. The bottom sheet itself is owned by `IOSRootNavigationView`.
    /// Nil on compact, where the chat header hosts the Settings gear instead.
    var onShowSettings: (() -> Void)?

    /// Invoked when the user archives the currently active conversation.
    /// The parent is responsible for (a) choosing a replacement conversation
    /// and (b) marking it as *seeded* (not an explicit open), so the
    /// replacement's `.task(id:)` does not silently clear its unread badge.
    /// The binding alone cannot communicate seed state, so this callback
    /// replaces the fallback `selectedConversationId = activeConversations.first?.id`
    /// when provided.
    var onArchiveActiveConversation: (() -> Void)?

    /// Single source of truth for the active conversation, owned by
    /// `IOSRootNavigationView.activeConversationId`. The binding keeps the
    /// iPad `NavigationSplitView` detail pane and the iPhone `compactRoot`
    /// chat in sync across size-class transitions (iPad Split View, rotation),
    /// so rotating from regular to compact continues to show the conversation
    /// the user was viewing rather than a stale seed.
    @Binding var selectedConversationId: UUID?

    private var isDrawerMode: Bool { onSelectConversation != nil }

    @State private var searchText: String = ""
    @State private var renamingConversationId: UUID?
    @State private var renameText: String = ""
    @State private var showArchived: Bool = false

    private var activeConversations: [IOSConversation] {
        // Exclude private conversations — they are managed separately via the Private Conversations
        // settings panel and must not appear in the main chat list.
        sortConversationsForDisplay(
            store.conversations.filter { !$0.isArchived && !$0.isPrivate },
            isConnectedMode: store.isConnectedMode
        )
    }

    /// Active conversations that are NOT from a schedule.
    private var regularConversations: [IOSConversation] {
        activeConversations.filter { !$0.isScheduleConversation }
    }

    /// Active conversations created by a schedule trigger (including one-shot/reminders).
    private var scheduleConversations: [IOSConversation] {
        activeConversations.filter { $0.isScheduleConversation }
    }

    /// Groups schedule conversations by their scheduleJobId for collapsible display.
    private var scheduleConversationGroups: [(key: String, label: String, conversations: [IOSConversation])] {
        var grouped: [String: [IOSConversation]] = [:]
        var order: [String] = []
        for conversation in filteredScheduleConversations {
            let key = conversation.scheduleJobId ?? conversation.conversationId ?? conversation.id.uuidString
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
            return (key: key, label: label, conversations: conversations)
        }
    }

    private var archivedConversations: [IOSConversation] {
        sortConversationsForDisplay(
            store.conversations.filter { $0.isArchived && !$0.isPrivate },
            isConnectedMode: store.isConnectedMode
        )
    }

    private var filteredActiveConversations: [IOSConversation] {
        guard !searchText.isEmpty else { return activeConversations }
        return activeConversations.filter { $0.title.localizedCaseInsensitiveContains(searchText) }
    }

    private var filteredRegularConversations: [IOSConversation] {
        guard !searchText.isEmpty else { return regularConversations }
        return regularConversations.filter { $0.title.localizedCaseInsensitiveContains(searchText) }
    }

    private var filteredScheduleConversations: [IOSConversation] {
        guard !searchText.isEmpty else { return scheduleConversations }
        return scheduleConversations.filter { $0.title.localizedCaseInsensitiveContains(searchText) }
    }

    private var filteredArchivedConversations: [IOSConversation] {
        guard !searchText.isEmpty else { return archivedConversations }
        return archivedConversations.filter { $0.title.localizedCaseInsensitiveContains(searchText) }
    }

    var body: some View {
        Group {
            if isDrawerMode {
                // Compact: the drawer supplies its own chrome; render only the list content.
                // `IOSRootNavigationView` owns navigation state and consumes selection requests.
                // The drawer's `safeAreaInset` footer keeps Settings reachable even while the
                // store is still loading its initial conversation list.
                if store.isLoadingInitialConversations {
                    loadingView
                } else {
                    conversationList
                }
            } else {
                // iPad: always mount the `NavigationSplitView` so the sidebar's
                // navigation bar — and the Settings toolbar item attached to it —
                // stays visible while the store is loading. Otherwise, first-run
                // users with no saved connection would be stuck on a plain
                // spinner with no way to reach Settings to configure a gateway.
                NavigationSplitView {
                    if store.isLoadingInitialConversations {
                        loadingView
                    } else {
                        conversationList
                    }
                } detail: {
                    detailView
                }
            }
        }
    }

    private var loadingView: some View {
        VStack(spacing: VSpacing.md) {
            ProgressView()
            Text("Loading chats\u{2026}")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle("Chats")
        .toolbar {
            // Mirror the Settings entry from `conversationList.toolbar` so iPad
            // first-run users can reach Settings even before the store's
            // initial conversation load completes. Compact reaches Settings
            // via the chat header gear and passes a nil callback here.
            if let onShowSettings {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: onShowSettings) {
                        VIconView(.settings, size: 20)
                    }
                    .accessibilityLabel("Settings")
                }
            }
        }
    }

    // MARK: - Detail Views

    @ViewBuilder
    private func conversationDetailContent(for conversationLocalId: UUID) -> some View {
        if let conversation = store.conversations.first(where: { $0.id == conversationLocalId }) {
            ConversationChatView(
                viewModel: store.viewModel(for: conversationLocalId),
                store: store,
                conversation: conversation
            )
            .task(id: conversationLocalId) {
                store.loadHistoryIfNeeded(for: conversationLocalId)
                store.markConversationSeenIfNeeded(conversationLocalId: conversationLocalId, isExplicitOpen: true)
                store.viewModel(for: conversationLocalId).consumeDeepLinkIfNeeded()
            }
            .onChange(of: conversation.hasUnseenLatestAssistantMessage) { _, hasUnseen in
                guard hasUnseen else { return }
                // The detail view can stay mounted across reconnects, so re-run
                // the explicit seen path when the visible conversation flips unread.
                store.markConversationSeenIfNeeded(conversationLocalId: conversationLocalId)
            }
            .onOpenURL { _ in
                DispatchQueue.main.async {
                    store.viewModel(for: conversationLocalId).consumeDeepLinkIfNeeded()
                }
            }
        } else {
            Text("Select a chat")
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var detailView: some View {
        if let selectedId = selectedConversationId {
            conversationDetailContent(for: selectedId)
        } else {
            Text("Select a chat")
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Conversation List

    private func archiveActiveConversation(_ conversation: IOSConversation) {
        store.archiveConversation(conversation)
        // Switch away from the archived conversation on both size classes.
        // `archiveConversation` only flips `isArchived` without removing
        // from `store.conversations`, so `IOSRootNavigationView.reconcileActiveConversation`'s
        // `.onChange(of: store.conversations.map(\.id))` trigger never fires
        // — the archived conversation would otherwise stay on-screen.
        // `selectedConversationId` is bound to `activeConversationId` in both
        // the iPad split view and the compact drawer, so assigning here
        // updates whichever path is active.
        guard selectedConversationId == conversation.id else { return }
        if let onArchiveActiveConversation {
            // Compact path: parent owns `activeConversationWasSeeded` and must
            // mark the replacement as seeded to avoid silently clearing its
            // unread badge via `compactRoot`'s `.task(id:)` auto-mark-seen.
            onArchiveActiveConversation()
        } else {
            // iPad path: `conversationDetailContent(for:)` always marks seen
            // on mount (no seeded gating), so a plain binding write is fine.
            selectedConversationId = activeConversations.first?.id
        }
    }

    private func beginRenaming(_ conversation: IOSConversation) {
        renamingConversationId = conversation.id
        renameText = conversation.title
    }

    /// Pin/Unpin is hidden on archived conversations. Reorder payloads filter
    /// archived entries, so a local pin would never reach the server, and
    /// `locallyEditedPinConversationIds` would then suppress inbound server pin state —
    /// leaving the conversation permanently divergent across devices.
    private func canToggleConversationPin(_ conversation: IOSConversation) -> Bool {
        store.isConnectedMode && conversation.conversationId != nil && !conversation.isArchived
    }

    /// Archive is hidden for channel-bound conversations (Telegram, Slack, etc.) to match
    /// macOS behavior in `ConversationActionsMenuContent`. Archiving a channel conversation
    /// loses the binding, so the assistant blocks it.
    private func canArchiveConversation(_ conversation: IOSConversation) -> Bool {
        !conversation.isChannelConversation
    }

    @ViewBuilder
    private func pinSwipeButton(for conversation: IOSConversation) -> some View {
        Button {
            if conversation.isPinned {
                store.unpinConversation(conversation)
            } else {
                store.pinConversation(conversation)
            }
        } label: {
            Label {
                Text(conversation.isPinned ? "Unpin" : "Pin")
            } icon: {
                VIconView(conversation.isPinned ? .pinOff : .pin, size: 14)
            }
        }
        .tint(VColor.primaryBase)
    }

    @ViewBuilder
    private func renameSwipeButton(for conversation: IOSConversation) -> some View {
        Button {
            beginRenaming(conversation)
        } label: {
            Label { Text("Rename") } icon: { VIconView(.pencil, size: 14) }
        }
        .tint(.blue) // Intentional: system blue for non-destructive swipe actions
    }

    @ViewBuilder
    private func leadingSwipeActions(for conversation: IOSConversation) -> some View {
        if canToggleConversationPin(conversation) {
            pinSwipeButton(for: conversation)
        }
        renameSwipeButton(for: conversation)
    }

    private func canMarkConversationUnread(_ conversation: IOSConversation) -> Bool {
        store.isConnectedMode &&
            conversation.conversationId != nil &&
            !conversation.hasUnseenLatestAssistantMessage &&
            conversation.latestAssistantMessageAt != nil
    }

    private func scheduleGroupHasUnread(_ group: (key: String, label: String, conversations: [IOSConversation])) -> Bool {
        store.isConnectedMode && group.conversations.contains(where: \.hasUnseenLatestAssistantMessage)
    }

    private func scheduleGroupHasPinned(_ group: (key: String, label: String, conversations: [IOSConversation])) -> Bool {
        store.isConnectedMode && group.conversations.contains(where: \.isPinned)
    }

    @ViewBuilder
    private func connectedConversationContextMenu(_ conversation: IOSConversation) -> some View {
        if canToggleConversationPin(conversation) {
            Button {
                if conversation.isPinned {
                    store.unpinConversation(conversation)
                } else {
                    store.pinConversation(conversation)
                }
            } label: {
                Label {
                    Text(conversation.isPinned ? "Unpin" : "Pin")
                } icon: {
                    VIconView(conversation.isPinned ? .pinOff : .pin, size: 14)
                }
            }
        }

        Button {
            beginRenaming(conversation)
        } label: {
            Label { Text("Rename") } icon: { VIconView(.pencil, size: 14) }
        }

        if canArchiveConversation(conversation) {
            Button {
                archiveActiveConversation(conversation)
            } label: {
                Label { Text("Archive") } icon: { VIconView(.archive, size: 14) }
            }
        }

        Button {
            store.markConversationUnread(conversation)
        } label: {
            Label { Text("Mark as unread") } icon: { VIconView(.circle, size: 14) }
        }
        .disabled(!canMarkConversationUnread(conversation))
    }

    @ViewBuilder
    private func maybeConnectedContextMenu<Content: View>(
        conversation: IOSConversation,
        @ViewBuilder content: () -> Content
    ) -> some View {
        if store.isConnectedMode {
            content()
                .contextMenu {
                    connectedConversationContextMenu(conversation)
                }
        } else {
            content()
        }
    }

    @ViewBuilder
    private func connectedScheduleGroupContextMenu(
        _ group: (key: String, label: String, conversations: [IOSConversation])
    ) -> some View {
        ForEach(group.conversations) { conversation in
            Menu {
                connectedConversationContextMenu(conversation)
            } label: {
                Label {
                    Text(conversation.title)
                } icon: {
                    VIconView(.messageCircle, size: 14)
                }
            }
        }
    }

    @ViewBuilder
    private func maybeConnectedScheduleGroupContextMenu<Content: View>(
        group: (key: String, label: String, conversations: [IOSConversation]),
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

    @ViewBuilder
    private func conversationRowLink(_ conversation: IOSConversation) -> some View {
        if let onSelect = onSelectConversation {
            Button {
                onSelect(conversation.id)
            } label: {
                conversationRow(conversation)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens this chat and closes the menu")
        } else {
            NavigationLink(value: conversation.id) {
                conversationRow(conversation)
            }
        }
    }

    private var conversationList: some View {
        List(selection: isDrawerMode ? nil : $selectedConversationId) {
            // Regular (non-schedule) conversations
            ForEach(filteredRegularConversations) { conversation in
                maybeConnectedContextMenu(conversation: conversation) {
                    conversationRowLink(conversation)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            store.deleteConversation(conversation)
                            if horizontalSizeClass == .regular && selectedConversationId == conversation.id {
                                selectedConversationId = activeConversations.first?.id
                            }
                        } label: {
                            Label { Text("Delete") } icon: { VIconView(.trash, size: 14) }
                        }
                        if canArchiveConversation(conversation) {
                            Button {
                                archiveActiveConversation(conversation)
                            } label: {
                                Label { Text("Archive") } icon: { VIconView(.archive, size: 14) }
                            }
                            .tint(VColor.systemNegativeHover)
                        }
                    }
                    .swipeActions(edge: .leading) {
                        leadingSwipeActions(for: conversation)
                    }
                }
            }

            // Scheduled conversations grouped by scheduleJobId
            if !filteredScheduleConversations.isEmpty {
                scheduledSection
            }

            if !archivedConversations.isEmpty {
                Section {
                    DisclosureGroup("Archived", isExpanded: $showArchived) {
                        ForEach(filteredArchivedConversations) { conversation in
                            conversationRowLink(conversation)
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    store.deleteConversation(conversation)
                                    if horizontalSizeClass == .regular && selectedConversationId == conversation.id {
                                        selectedConversationId = activeConversations.first?.id
                                    }
                                } label: {
                                    Label { Text("Delete") } icon: { VIconView(.trash, size: 14) }
                                }
                                Button {
                                    store.unarchiveConversation(conversation)
                                } label: {
                                    Label { Text("Unarchive") } icon: { VIconView(.inbox, size: 14) }
                                }
                                .tint(.blue) // Intentional: system blue for non-destructive swipe actions
                            }
                            .swipeActions(edge: .leading) {
                                leadingSwipeActions(for: conversation)
                            }
                        }
                    }
                }
            }

            // Load-more trigger: appears when the daemon has additional conversations beyond
            // the current page. Becomes visible as the user scrolls toward the bottom.
            if store.hasMoreConversations || store.isLoadingMoreConversations {
                HStack {
                    Spacer()
                    if store.isLoadingMoreConversations {
                        VLoadingIndicator(size: 18)
                    } else {
                        // Invisible sentinel: triggers the next page fetch on appear.
                        Color.clear.frame(height: 1)
                    }
                    Spacer()
                }
                .listRowSeparator(.hidden)
                .onAppear {
                    store.loadMoreConversations()
                }
            }
        }
        .searchable(text: $searchText, prompt: "Search chats")
        .navigationTitle("Chats")
        .refreshable {
            await store.refreshConversationList(daemon: clientProvider.client)
        }
        .toolbar {
            if let onShowSettings {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: onShowSettings) {
                        VIconView(.settings, size: 20)
                    }
                    .accessibilityLabel("Settings")
                }
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    let conversation = store.newConversation()
                    if let onSelect = onSelectConversation {
                        onSelect(conversation.id)
                    } else {
                        selectedConversationId = conversation.id
                    }
                } label: {
                    VIconView(.squarePen, size: 20)
                }
                .accessibilityLabel("New chat")
            }
        }
        .alert("Rename Chat", isPresented: Binding(
            get: { renamingConversationId != nil },
            set: { if !$0 { renamingConversationId = nil } }
        )) {
            TextField("Title", text: $renameText)
            Button("Cancel", role: .cancel) { renamingConversationId = nil }
            Button("Save") {
                if let id = renamingConversationId, !renameText.isEmpty {
                    store.updateTitle(renameText, for: id)
                }
                renamingConversationId = nil
            }
        } message: {
            Text("Enter a new name for this chat")
        }
    }

    // MARK: - Scheduled Section

    private var scheduledSection: some View {
        Section("Scheduled") {
            ForEach(scheduleConversationGroups, id: \.key) { group in
                scheduleGroupRow(group)
            }
        }
    }

    @ViewBuilder
    private func scheduleGroupRow(_ group: (key: String, label: String, conversations: [IOSConversation])) -> some View {
        if group.conversations.count == 1, let conversation = group.conversations.first {
            // Single-conversation group: render inline
            maybeConnectedContextMenu(conversation: conversation) {
                conversationRowLink(conversation)
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        store.deleteConversation(conversation)
                        if horizontalSizeClass == .regular && selectedConversationId == conversation.id {
                            selectedConversationId = activeConversations.first?.id
                        }
                    } label: {
                        Label { Text("Delete") } icon: { VIconView(.trash, size: 14) }
                    }
                    if canArchiveConversation(conversation) {
                        Button {
                            archiveActiveConversation(conversation)
                        } label: {
                            Label { Text("Archive") } icon: { VIconView(.archive, size: 14) }
                        }
                        .tint(VColor.systemNegativeHover)
                    }
                }
                .swipeActions(edge: .leading) {
                    leadingSwipeActions(for: conversation)
                }
            }
        } else {
            // Multi-conversation group: DisclosureGroup with fully-tappable label.
            // Context menu is on the label only so tap-to-expand (on the disclosure chevron)
            // and long-press-for-menu remain distinct gestures.
            DisclosureGroup {
                ForEach(group.conversations) { conversation in
                    maybeConnectedContextMenu(conversation: conversation) {
                        conversationRowLink(conversation)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                store.deleteConversation(conversation)
                                if horizontalSizeClass == .regular && selectedConversationId == conversation.id {
                                    selectedConversationId = activeConversations.first?.id
                                }
                            } label: {
                                Label { Text("Delete") } icon: { VIconView(.trash, size: 14) }
                            }
                            if canArchiveConversation(conversation) {
                                Button {
                                    archiveActiveConversation(conversation)
                                } label: {
                                    Label { Text("Archive") } icon: { VIconView(.archive, size: 14) }
                                }
                                .tint(VColor.systemNegativeHover)
                            }
                        }
                        .swipeActions(edge: .leading) {
                            leadingSwipeActions(for: conversation)
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
                                .foregroundStyle(VColor.primaryBase)
                                .accessibilityLabel("Pinned")
                        }
                        if scheduleGroupHasUnread(group) {
                            VBadge(style: .dot, color: VColor.systemMidStrong)
                                .accessibilityLabel("Unread")
                        }
                        Text("\(group.conversations.count)")
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

    // MARK: - Conversation Row

    private func conversationRow(_ conversation: IOSConversation) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                VIconView(.messageCircle, size: 12)
                    .foregroundStyle(.secondary)
                Text(conversation.title)
                    .fontWeight(
                        store.isConnectedMode && conversation.hasUnseenLatestAssistantMessage
                            ? .semibold
                            : .regular
                    )
                    .lineLimit(1)
                if store.isConnectedMode && conversation.isPinned {
                    VIconView(.pin, size: 10)
                        .foregroundStyle(VColor.primaryBase)
                        .accessibilityLabel("Pinned")
                }
                if store.isConnectedMode && conversation.hasUnseenLatestAssistantMessage {
                    VBadge(style: .dot, color: VColor.systemMidStrong)
                        .accessibilityLabel("Unread")
                }
                Spacer()
                Text(relativeDate(conversation.lastActivityAt))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            if let preview = store.lastMessagePreview(for: conversation.id) {
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

// MARK: - ConversationChatView

/// Thin wrapper around ChatContentView for a conversation-owned ChatViewModel.
struct ConversationChatView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    var viewModel: ChatViewModel
    @ObservedObject var store: IOSConversationStore
    let conversation: IOSConversation
    /// Opens the conversation drawer. Non-nil only on compact size classes where
    /// `IOSRootNavigationView` owns the drawer state; iPad uses its persistent
    /// NavigationSplitView sidebar instead.
    var onOpenDrawer: (() -> Void)?
    /// Starts a new conversation. Non-nil only on compact size classes.
    var onComposeNew: (() -> Void)?
    /// Presents the Settings bottom sheet. Non-nil only on compact size classes;
    /// iPad reaches Settings via the persistent sidebar toolbar instead.
    var onShowSettings: (() -> Void)?

    var body: some View {
        let anchorRequest = store.pendingAnchorRequest(for: conversation.id)
        VStack(spacing: 0) {
            if let parentChromeAction = makeOpenForkParentAction(store: store, conversation: conversation),
               let forkParent = conversation.forkParent {
                forkParentChrome(forkParent: forkParent, action: parentChromeAction)
            }

            // Low-balance / depleted-credits banner (LUM-1004). Self-contained:
            // fetches the billing summary on appear and routes the "Top up"
            // affordance to the web billing page in SFSafariViewController.
            // Renders inline so it stacks cleanly under any fork chrome above
            // and above the chat content below.
            LowBalanceBannerHost()

            ChatContentView(
                viewModel: viewModel,
                pendingAnchorRequestId: anchorRequest?.id,
                pendingAnchorDaemonMessageId: anchorRequest?.daemonMessageId,
                onPendingAnchorHandled: { requestId in
                    store.consumePendingAnchorRequest(id: requestId)
                },
                onForkFromMessage: makeConversationForkFromMessageAction(
                    store: store,
                    conversation: conversation
                )
            )
        }
        .navigationTitle(conversation.title.isEmpty ? "Chat" : conversation.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if horizontalSizeClass == .compact, let onOpenDrawer {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: onOpenDrawer) {
                        VIconView(.panelLeft, size: 20)
                    }
                    .accessibilityLabel("Chats")
                }
                .hideSharedToolbarBackgroundIfAvailable()
            }
            if horizontalSizeClass == .compact, let onShowSettings {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: onShowSettings) {
                        VIconView(.settings, size: 20)
                    }
                    .accessibilityLabel("Settings")
                }
                .hideSharedToolbarBackgroundIfAvailable()
            }
            if horizontalSizeClass == .compact, let onComposeNew {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: onComposeNew) {
                        VIconView(.squarePen, size: 20)
                    }
                    .accessibilityLabel("New chat")
                }
                .hideSharedToolbarBackgroundIfAvailable()
            }
        }
    }

    @ViewBuilder
    private func forkParentChrome(
        forkParent: ConversationForkParent,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: VSpacing.sm) {
                VIconView(.gitBranch, size: 14)
                    .foregroundStyle(VColor.primaryBase)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Forked from")
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.contentSecondary)
                    Text(forkParent.title ?? "Parent conversation")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentDefault)
                        .lineLimit(1)
                }

                Spacer()

                VIconView(.chevronRight, size: 14)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)
            .background(VColor.surfaceBase)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(VColor.borderBase)
                    .frame(height: 1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open parent conversation")
        .accessibilityHint("Opens the conversation this chat forked from")
    }
}

#endif
