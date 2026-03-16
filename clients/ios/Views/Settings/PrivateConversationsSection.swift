#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Manages private (temporary) conversations on iOS, mirroring the macOS private conversation
/// workflow. Private conversations are backed by daemon sessions with conversationType "private"
/// so they are excluded from normal session restoration and the main conversation list.
struct PrivateConversationsSection: View {
    /// Shared with the main ConversationListView so both views read from and write to the
    /// same in-memory conversation list. This prevents the dual-store data-loss bug where
    /// two independent stores each overwrite the other's UserDefaults changes.
    @ObservedObject var store: IOSConversationStore
    @State private var showingCreateSheet = false
    @State private var newConversationName = ""
    @State private var renamingConversation: IOSConversation?
    @State private var renameText = ""
    @State private var conversationToDelete: IOSConversation?
    @State private var showingDeleteConfirmation = false

    var body: some View {
        Form {
            if store.privateConversations.isEmpty {
                Section {
                    Text("No private threads yet.")
                        .foregroundStyle(.secondary)
                    Text("Private threads are excluded from your main chat history. Use them for sensitive threads that you don't want mixed with your regular threads.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                Section {
                    ForEach(store.privateConversations) { conversation in
                        NavigationLink {
                            privateConversationChatView(for: conversation)
                        } label: {
                            privateConversationRow(conversation)
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                conversationToDelete = conversation
                                showingDeleteConfirmation = true
                            } label: {
                                Label { Text("Delete") } icon: { VIconView(.trash, size: 14) }
                            }
                        }
                        .swipeActions(edge: .leading) {
                            Button {
                                renamingConversation = conversation
                                renameText = conversation.title
                            } label: {
                                Label { Text("Rename") } icon: { VIconView(.pencil, size: 14) }
                            }
                            .tint(.blue) // Intentional: system blue for non-destructive swipe actions
                        }
                    }
                } header: {
                    Text("Private Threads")
                } footer: {
                    Text("These threads are not included in your regular chat history and are excluded from session restoration.")
                }
            }

            Section {
                Button {
                    newConversationName = ""
                    showingCreateSheet = true
                } label: {
                    Label { Text("New Private Thread") } icon: { VIconView(.shield, size: 14) }
                }
            }
        }
        .navigationTitle("Private Threads")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showingCreateSheet) {
            createConversationSheet
        }
        .alert("Rename Thread", isPresented: Binding(
            get: { renamingConversation != nil },
            set: { if !$0 { renamingConversation = nil } }
        )) {
            TextField("Thread name", text: $renameText)
            Button("Cancel", role: .cancel) { renamingConversation = nil }
            Button("Save") {
                if let conversation = renamingConversation, !renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    store.updateTitle(renameText.trimmingCharacters(in: .whitespacesAndNewlines), for: conversation.id)
                }
                renamingConversation = nil
            }
        } message: {
            Text("Enter a new name for this private thread.")
        }
        .alert("Delete Thread", isPresented: $showingDeleteConfirmation) {
            Button("Cancel", role: .cancel) { conversationToDelete = nil }
            Button("Delete", role: .destructive) {
                if let conversation = conversationToDelete {
                    store.deleteConversation(conversation)
                }
                conversationToDelete = nil
            }
        } message: {
            if let conversation = conversationToDelete {
                Text("Delete \"\(conversation.title)\"? This cannot be undone.")
            }
        }
    }

    // MARK: - Conversation Row

    private func privateConversationRow(_ conversation: IOSConversation) -> some View {
        HStack {
            VIconView(.shield, size: 12)
                .foregroundStyle(VColor.primaryBase)
            VStack(alignment: .leading, spacing: 2) {
                Text(conversation.title)
                    .lineLimit(1)
                Text(relativeDate(conversation.lastActivityAt))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Conversation Chat

    @ViewBuilder
    private func privateConversationChatView(for conversation: IOSConversation) -> some View {
        ConversationChatView(
            viewModel: store.viewModel(for: conversation.id),
            conversationTitle: conversation.title
        )
        .onAppear {
            store.loadHistoryIfNeeded(for: conversation.id)
        }
    }

    // MARK: - Create Sheet

    private var createConversationSheet: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Thread name", text: $newConversationName)
                        .autocapitalization(.words)
                } footer: {
                    Text("Give this private thread a name so you can identify it later.")
                }
            }
            .navigationTitle("New Private Thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        showingCreateSheet = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        let name = newConversationName.trimmingCharacters(in: .whitespacesAndNewlines)
                        _ = store.newPrivateConversation(name: name.isEmpty ? "Private Thread" : name)
                        showingCreateSheet = false
                    }
                }
            }
        }
    }

    private func relativeDate(_ date: Date) -> String {
        DateFormatting.relativeTimestamp(date)
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        PrivateConversationsSection(store: IOSConversationStore(daemonClient: MockDaemonClient()))
    }
}
#endif
#endif
