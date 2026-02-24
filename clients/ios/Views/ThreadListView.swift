#if canImport(UIKit)
import SwiftUI
import UIKit
import VellumAssistantShared

// MARK: - ThreadListView

struct ThreadListView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @StateObject private var store: IOSThreadStore
    @State private var navigationPath: [UUID] = []
    @State private var selectedThreadId: UUID?
    @State private var searchText: String = ""
    @State private var renamingThreadId: UUID?
    @State private var renameText: String = ""
    @State private var showArchived: Bool = false

    init(daemonClient: any DaemonClientProtocol) {
        _store = StateObject(wrappedValue: IOSThreadStore(daemonClient: daemonClient))
    }

    private var activeThreads: [IOSThread] {
        store.threads.filter { !$0.isArchived }
    }

    private var archivedThreads: [IOSThread] {
        store.threads.filter { $0.isArchived }
    }

    private var filteredActiveThreads: [IOSThread] {
        guard !searchText.isEmpty else { return activeThreads }
        return activeThreads.filter { $0.title.localizedCaseInsensitiveContains(searchText) }
    }

    private var filteredArchivedThreads: [IOSThread] {
        guard !searchText.isEmpty else { return archivedThreads }
        return archivedThreads.filter { $0.title.localizedCaseInsensitiveContains(searchText) }
    }

    var body: some View {
        if horizontalSizeClass == .regular {
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
                store.viewModel(for: threadId).consumeDeepLinkIfNeeded()
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

    private var threadList: some View {
        List(selection: horizontalSizeClass == .regular ? $selectedThreadId : nil) {
            ForEach(filteredActiveThreads) { thread in
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
                        Label("Delete", systemImage: "trash")
                    }
                    Button {
                        store.archiveThread(thread)
                        if horizontalSizeClass == .regular && selectedThreadId == thread.id {
                            selectedThreadId = activeThreads.first?.id
                        }
                    } label: {
                        Label("Archive", systemImage: "archivebox")
                    }
                    .tint(VColor.warning)
                }
                .swipeActions(edge: .leading) {
                    Button {
                        renamingThreadId = thread.id
                        renameText = thread.title
                    } label: {
                        Label("Rename", systemImage: "pencil")
                    }
                    .tint(.blue) // Intentional: system blue for non-destructive swipe actions
                }
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
                                    Label("Delete", systemImage: "trash")
                                }
                                Button {
                                    store.unarchiveThread(thread)
                                } label: {
                                    Label("Unarchive", systemImage: "tray.and.arrow.up")
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
                    Image(systemName: "square.and.pencil")
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

    // MARK: - Thread Row

    private func threadRow(_ thread: IOSThread) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Image(systemName: "bubble.left")
                    .foregroundStyle(.secondary)
                    .font(.caption)
                Text(thread.title)
                    .lineLimit(1)
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

    @State private var showCopiedConfirmation = false
    @State private var showShareSheet = false
    @State private var shareMarkdown: String = ""

    var body: some View {
        ChatContentView(viewModel: viewModel)
            .navigationTitle("Chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    exportMenu
                }
            }
            .sheet(isPresented: $showShareSheet) {
                ActivityViewController(activityItems: [shareMarkdown])
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
                Label(
                    showCopiedConfirmation ? "Copied!" : "Copy as Markdown",
                    systemImage: showCopiedConfirmation ? "checkmark" : "doc.on.doc"
                )
            }

            Button {
                let markdown = buildMarkdown()
                guard !markdown.isEmpty else { return }
                shareMarkdown = markdown
                showShareSheet = true
            } label: {
                Label("Share\u{2026}", systemImage: "square.and.arrow.up")
            }
        } label: {
            Image(systemName: showCopiedConfirmation ? "checkmark" : "square.and.arrow.up")
                .foregroundColor(showCopiedConfirmation ? VColor.success : VColor.textMuted)
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
