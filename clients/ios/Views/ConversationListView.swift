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

func applyConversationSelectionRequest(
    _ request: ConversationSelectionRequest,
    horizontalSizeClass: UserInterfaceSizeClass?,
    navigationPath: inout [UUID],
    selectedConversationId: inout UUID?
) {
    if horizontalSizeClass == .regular {
        selectedConversationId = request.conversationLocalId
    } else {
        navigationPath = [request.conversationLocalId]
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

// MARK: - Tab Entry Point

/// The tab-level Chats entry point. Switches between connected and disconnected
/// states so ConversationListView only mounts when a live GatewayConnectionManager is available.
/// When the user has a platform assistant configured, shows the conversation list
/// (with its loading state) instead of the disconnected view while connecting.
struct ChatsTabView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @ObservedObject var store: IOSConversationStore
    var onConnectTapped: (() -> Void)?

    /// Whether the user has previously saved daemon connection settings.
    /// When true, the app is either connected or actively attempting to connect,
    /// so the conversation list (with loading state) is shown instead of the
    /// disconnected placeholder.
    private var hasSavedConnectionSettings: Bool {
        if let id = UserDefaults.standard.string(forKey: UserDefaultsKeys.managedAssistantId), !id.isEmpty,
           let url = UserDefaults.standard.string(forKey: UserDefaultsKeys.managedPlatformBaseURL), !url.isEmpty {
            return true
        }
        if let url = UserDefaults.standard.string(forKey: UserDefaultsKeys.gatewayBaseURL), !url.isEmpty {
            return true
        }
        return false
    }

    var body: some View {
        if clientProvider.isConnected || hasSavedConnectionSettings {
            ConversationListView(store: store)
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
                    .foregroundStyle(VColor.contentTertiary)
                    .accessibilityHidden(true)
                Text("Chats Require Connection")
                    .font(VFont.titleMedium)
                    .foregroundStyle(VColor.contentDefault)
                Text("Connect to your Assistant to start a conversation.")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
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

// MARK: - ConversationListView

struct ConversationListView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @EnvironmentObject var clientProvider: ClientProvider
    @ObservedObject var store: IOSConversationStore
    @State private var navigationPath: [UUID] = []
    @State private var selectedConversationId: UUID?
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
            if store.isLoadingInitialConversations {
                loadingView
            } else if horizontalSizeClass == .regular {
                NavigationSplitView {
                    conversationList
                } detail: {
                    detailView
                }
            } else {
                NavigationStack(path: $navigationPath) {
                    conversationList
                        .navigationDestination(for: UUID.self) { conversationLocalId in
                            conversationDetailContent(for: conversationLocalId)
                                .toolbar(.hidden, for: .tabBar)
                        }
                }
            }
        }
        .onAppear {
            applyPendingSelectionRequestIfNeeded()
        }
        .onChange(of: store.selectionRequest?.id) { _, _ in
            applyPendingSelectionRequestIfNeeded()
        }
    }

    private func applyPendingSelectionRequestIfNeeded() {
        guard let request = store.selectionRequest else { return }
        applyConversationSelectionRequest(
            request,
            horizontalSizeClass: horizontalSizeClass,
            navigationPath: &navigationPath,
            selectedConversationId: &selectedConversationId
        )
        store.consumeSelectionRequest(id: request.id)
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
        if horizontalSizeClass == .regular && selectedConversationId == conversation.id {
            selectedConversationId = activeConversations.first?.id
        }
    }

    private func beginRenaming(_ conversation: IOSConversation) {
        renamingConversationId = conversation.id
        renameText = conversation.title
    }

    /// Pin/Unpin is hidden on archived conversations: `sendReorderConversations()` filters
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

    private var conversationList: some View {
        List(selection: horizontalSizeClass == .regular ? $selectedConversationId : nil) {
            // Regular (non-schedule) conversations
            ForEach(filteredRegularConversations) { conversation in
                maybeConnectedContextMenu(conversation: conversation) {
                    NavigationLink(value: conversation.id) {
                        conversationRow(conversation)
                    }
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
                            NavigationLink(value: conversation.id) {
                                conversationRow(conversation)
                            }
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
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    let conversation = store.newConversation()
                    if horizontalSizeClass == .regular {
                        selectedConversationId = conversation.id
                    } else {
                        navigationPath = [conversation.id]
                    }
                } label: {
                    VIconView(.squarePen, size: 20)
}
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
                NavigationLink(value: conversation.id) {
                    conversationRow(conversation)
                }
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
                        NavigationLink(value: conversation.id) {
                            conversationRow(conversation)
                        }
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
    var viewModel: ChatViewModel
    @ObservedObject var store: IOSConversationStore
    let conversation: IOSConversation

    var body: some View {
        let anchorRequest = store.pendingAnchorRequest(for: conversation.id)
        VStack(spacing: 0) {
            if let parentChromeAction = makeOpenForkParentAction(store: store, conversation: conversation),
               let forkParent = conversation.forkParent {
                forkParentChrome(forkParent: forkParent, action: parentChromeAction)
            }

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
            .navigationTitle("Chat")
            .navigationBarTitleDisplayMode(.inline)
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
