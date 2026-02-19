#if canImport(UIKit)
import SwiftUI
import UIKit
import VellumAssistantShared

// MARK: - ThreadListView

struct ThreadListView: View {
    @StateObject private var store: IOSThreadStore
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
        NavigationSplitView {
            threadList
        } detail: {
            detailView
        }
    }

    // MARK: - Sidebar

    private var threadList: some View {
        List(selection: $selectedThreadId) {
            ForEach(filteredActiveThreads) { thread in
                NavigationLink(value: thread.id) {
                    threadRow(thread)
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        store.deleteThread(thread)
                        if selectedThreadId == thread.id {
                            selectedThreadId = activeThreads.first?.id
                        }
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    Button {
                        store.archiveThread(thread)
                        if selectedThreadId == thread.id {
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
                                    let wasSelected = selectedThreadId == thread.id
                                    store.deleteThread(thread)
                                    if wasSelected {
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
        }
        .searchable(text: $searchText, prompt: "Search chats")
        .navigationTitle("Chats")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    store.newThread()
                    selectedThreadId = store.threads.last?.id
                } label: {
                    Image(systemName: "square.and.pencil")
                }
            }
        }
        .onAppear {
            if selectedThreadId == nil {
                selectedThreadId = activeThreads.first?.id
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

    // MARK: - Detail

    @ViewBuilder
    private var detailView: some View {
        if let selectedId = selectedThreadId,
           let thread = store.threads.first(where: { $0.id == selectedId }) {
            ThreadChatView(
                viewModel: store.viewModel(for: selectedId),
                threadTitle: thread.title
            )
                .onAppear {
                    store.loadHistoryIfNeeded(for: selectedId)
                    store.viewModel(for: selectedId).consumeDeepLinkIfNeeded()
                }
                .onOpenURL { _ in
                    DispatchQueue.main.async {
                        store.viewModel(for: selectedId).consumeDeepLinkIfNeeded()
                    }
                }
        } else {
            Text("Select a chat")
                .foregroundStyle(.secondary)
        }
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
