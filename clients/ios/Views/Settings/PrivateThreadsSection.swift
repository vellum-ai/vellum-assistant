#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Manages private (temporary) threads on iOS, mirroring the macOS private thread
/// workflow. Private threads are backed by daemon sessions with threadType "private"
/// so they are excluded from normal session restoration and the main thread list.
struct PrivateThreadsSection: View {
    /// Shared with the main ThreadListView so both views read from and write to the
    /// same in-memory thread list. This prevents the dual-store data-loss bug where
    /// two independent stores each overwrite the other's UserDefaults changes.
    @ObservedObject var store: IOSThreadStore
    @State private var showingCreateSheet = false
    @State private var newThreadName = ""
    @State private var renamingThread: IOSThread?
    @State private var renameText = ""
    @State private var threadToDelete: IOSThread?
    @State private var showingDeleteConfirmation = false

    var body: some View {
        Form {
            if store.privateThreads.isEmpty {
                Section {
                    Text("No private threads yet.")
                        .foregroundStyle(.secondary)
                    Text("Private threads are excluded from your main chat history. Use them for sensitive conversations that you don't want mixed with your regular threads.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                Section {
                    ForEach(store.privateThreads) { thread in
                        NavigationLink {
                            privateThreadChatView(for: thread)
                        } label: {
                            privateThreadRow(thread)
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                threadToDelete = thread
                                showingDeleteConfirmation = true
                            } label: {
                                Label { Text("Delete") } icon: { VIconView(.trash, size: 14) }
                            }
                        }
                        .swipeActions(edge: .leading) {
                            Button {
                                renamingThread = thread
                                renameText = thread.title
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
                    newThreadName = ""
                    showingCreateSheet = true
                } label: {
                    Label { Text("New Private Thread") } icon: { VIconView(.shield, size: 14) }
                }
            }
        }
        .navigationTitle("Private Threads")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showingCreateSheet) {
            createThreadSheet
        }
        .alert("Rename Thread", isPresented: Binding(
            get: { renamingThread != nil },
            set: { if !$0 { renamingThread = nil } }
        )) {
            TextField("Thread name", text: $renameText)
            Button("Cancel", role: .cancel) { renamingThread = nil }
            Button("Save") {
                if let thread = renamingThread, !renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    store.updateTitle(renameText.trimmingCharacters(in: .whitespacesAndNewlines), for: thread.id)
                }
                renamingThread = nil
            }
        } message: {
            Text("Enter a new name for this private thread.")
        }
        .alert("Delete Thread", isPresented: $showingDeleteConfirmation) {
            Button("Cancel", role: .cancel) { threadToDelete = nil }
            Button("Delete", role: .destructive) {
                if let thread = threadToDelete {
                    store.deleteThread(thread)
                }
                threadToDelete = nil
            }
        } message: {
            if let thread = threadToDelete {
                Text("Delete \"\(thread.title)\"? This cannot be undone.")
            }
        }
    }

    // MARK: - Thread Row

    private func privateThreadRow(_ thread: IOSThread) -> some View {
        HStack {
            VIconView(.shield, size: 12)
                .foregroundStyle(VColor.primaryBase)
            VStack(alignment: .leading, spacing: 2) {
                Text(thread.title)
                    .lineLimit(1)
                Text(relativeDate(thread.lastActivityAt))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Thread Chat

    @ViewBuilder
    private func privateThreadChatView(for thread: IOSThread) -> some View {
        ThreadChatView(
            viewModel: store.viewModel(for: thread.id),
            threadTitle: thread.title
        )
        .onAppear {
            store.loadHistoryIfNeeded(for: thread.id)
        }
    }

    // MARK: - Create Sheet

    private var createThreadSheet: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Thread name", text: $newThreadName)
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
                        let name = newThreadName.trimmingCharacters(in: .whitespacesAndNewlines)
                        _ = store.newPrivateThread(name: name.isEmpty ? "Private Thread" : name)
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
        PrivateThreadsSection(store: IOSThreadStore(daemonClient: MockDaemonClient()))
    }
}
#endif
#endif
