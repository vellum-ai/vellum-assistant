#if canImport(UIKit)
import Combine
import SwiftUI
import VellumAssistantShared

// MARK: - IOSThread

/// Represents a single local chat thread on iOS.
struct IOSThread: Identifiable {
    let id: UUID
    var title: String
    let createdAt: Date

    init(id: UUID = UUID(), title: String = "New Chat", createdAt: Date = Date()) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
    }
}

// MARK: - PersistedThread

/// Codable representation of IOSThread for UserDefaults persistence.
private struct PersistedThread: Codable {
    var id: UUID
    var title: String
    var createdAt: Date
}

// MARK: - IOSThreadStore

/// Manages a list of local chat threads for iOS with JSON persistence via UserDefaults.
/// Each thread owns an independent ChatViewModel instance so threads
/// do not share message history or sending state.
@MainActor
class IOSThreadStore: ObservableObject {
    @Published var threads: [IOSThread] = []

    /// ViewModels keyed by thread ID, created lazily on first access.
    private var viewModels: [UUID: ChatViewModel] = [:]
    private let daemonClient: any DaemonClientProtocol
    private static let persistenceKey = "ios_threads_v1"
    private var cancellables: Set<AnyCancellable> = []

    init(daemonClient: any DaemonClientProtocol) {
        self.daemonClient = daemonClient
        let loaded = Self.load()
        if loaded.isEmpty {
            // First launch: create a default thread without persisting yet
            let thread = IOSThread()
            threads = [thread]
            save()
        } else {
            threads = loaded
        }
    }

    /// Return the ChatViewModel for the given thread, creating it if necessary.
    func viewModel(for threadId: UUID) -> ChatViewModel {
        if let existing = viewModels[threadId] {
            return existing
        }
        let vm = ChatViewModel(daemonClient: daemonClient)
        viewModels[threadId] = vm
        observeForTitleGeneration(vm: vm, threadId: threadId)
        return vm
    }

    /// Watch for the first completed assistant reply to auto-title the thread.
    private func observeForTitleGeneration(vm: ChatViewModel, threadId: UUID) {
        // Find the thread's default title; skip if already customized.
        guard threads.first(where: { $0.id == threadId })?.title == "New Chat" else { return }

        vm.$messages
            .dropFirst()
            .compactMap { messages -> String? in
                // Trigger once we have at least one user message and the first assistant
                // reply has finished streaming (isStreaming == false).
                guard let firstUser = messages.first(where: { $0.role == .user }),
                      !firstUser.text.isEmpty,
                      messages.contains(where: { $0.role == .assistant && !$0.isStreaming }) else {
                    return nil
                }
                return firstUser.text
            }
            .first()
            .sink { [weak self] firstUserMessage in
                guard let self else { return }
                Task {
                    if let title = await TitleGenerator.shared.generateTitle(
                        for: threadId,
                        firstUserMessage: firstUserMessage
                    ) {
                        await MainActor.run {
                            self.updateTitle(title, for: threadId)
                        }
                    }
                }
            }
            .store(in: &cancellables)
    }

    @discardableResult
    func newThread() -> IOSThread {
        let thread = IOSThread()
        threads.append(thread)
        save()
        return thread
    }

    func deleteThread(_ thread: IOSThread) {
        viewModels.removeValue(forKey: thread.id)
        threads.removeAll { $0.id == thread.id }
        // Always keep at least one thread.
        if threads.isEmpty {
            newThread()
        } else {
            save()
        }
    }

    func updateTitle(_ title: String, for threadId: UUID) {
        guard let idx = threads.firstIndex(where: { $0.id == threadId }) else { return }
        threads[idx].title = title
        save()
    }

    // MARK: - Persistence

    private func save() {
        let persisted = threads.map { PersistedThread(id: $0.id, title: $0.title, createdAt: $0.createdAt) }
        if let data = try? JSONEncoder().encode(persisted) {
            UserDefaults.standard.set(data, forKey: Self.persistenceKey)
        }
    }

    private static func load() -> [IOSThread] {
        guard let data = UserDefaults.standard.data(forKey: persistenceKey),
              let persisted = try? JSONDecoder().decode([PersistedThread].self, from: data) else {
            return []
        }
        return persisted.map { IOSThread(id: $0.id, title: $0.title, createdAt: $0.createdAt) }
    }
}

// MARK: - ThreadListView

struct ThreadListView: View {
    @StateObject private var store: IOSThreadStore
    @State private var selectedThreadId: UUID?

    init(daemonClient: any DaemonClientProtocol) {
        _store = StateObject(wrappedValue: IOSThreadStore(daemonClient: daemonClient))
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
        List(store.threads, selection: $selectedThreadId) { thread in
            NavigationLink(value: thread.id) {
                Label(thread.title, systemImage: "bubble.left")
            }
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) {
                    store.deleteThread(thread)
                    if selectedThreadId == thread.id {
                        selectedThreadId = store.threads.first?.id
                    }
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
        .navigationTitle("Chats")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    store.newThread()
                    // Auto-select the newly created thread.
                    selectedThreadId = store.threads.last?.id
                } label: {
                    Image(systemName: "square.and.pencil")
                }
            }
        }
        .onAppear {
            // Select the first thread automatically on launch.
            if selectedThreadId == nil {
                selectedThreadId = store.threads.first?.id
            }
        }
    }

    // MARK: - Detail

    @ViewBuilder
    private var detailView: some View {
        if let selectedId = selectedThreadId,
           store.threads.contains(where: { $0.id == selectedId }) {
            ThreadChatView(viewModel: store.viewModel(for: selectedId))
        } else {
            Text("Select a chat")
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - ThreadChatView

/// Wraps ChatTabView with a pre-existing ChatViewModel (one per thread).
struct ThreadChatView: View {
    @ObservedObject var viewModel: ChatViewModel
    @FocusState private var isInputFocused: Bool
    @Environment(\.colorScheme) private var colorScheme
    @State private var emptyStateVisible = false
    @State private var greeting: String = {
        let choices = [
            "What are we working on?",
            "I'm here whenever you need me.",
            "What's on your mind?",
            "Let's make something happen.",
            "Ready when you are.",
        ]
        return choices.randomElement()!
    }()

    var body: some View {
        VStack(spacing: 0) {
            // Messages area — empty state when no messages, otherwise scrollable list
            if viewModel.messages.isEmpty && !viewModel.isSending && !viewModel.isThinking {
                emptyStateView
            } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: VSpacing.md) {
                        let messages = viewModel.messages
                        ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                            let isLastAssistant = message.role == .assistant
                                && !message.isStreaming
                                && (index == messages.count - 1
                                    || (index == messages.count - 2
                                        && messages[messages.count - 1].confirmation != nil
                                        && messages[messages.count - 1].confirmation?.state != .pending))
                                && !viewModel.isSending
                                && !viewModel.isThinking
                            MessageBubbleView(
                                message: message,
                                onConfirmationResponse: { requestId, decision in
                                    viewModel.respondToConfirmation(requestId: requestId, decision: decision)
                                },
                                onSurfaceAction: { surfaceId, actionId, data in
                                    viewModel.sendSurfaceAction(surfaceId: surfaceId, actionId: actionId, data: data)
                                },
                                onRegenerate: isLastAssistant ? { viewModel.regenerateLastMessage() } : nil
                            )
                            .id(message.id)
                        }

                        // Current step indicator shown while generating
                        if viewModel.isSending {
                            let allToolCalls = viewModel.messages.last?.toolCalls ?? []
                            CurrentStepIndicator(
                                toolCalls: allToolCalls,
                                isStreaming: viewModel.isSending,
                                onTap: {}
                            )
                            .padding(.horizontal, VSpacing.lg)
                            .id("step-indicator")
                        }
                    }
                    .padding(VSpacing.lg)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: viewModel.messages.count) { _, _ in
                    scrollToBottom(proxy: proxy, animated: true)
                }
                .onChange(of: viewModel.messages.last?.text) { _, _ in
                    if viewModel.messages.last?.isStreaming == true {
                        scrollToBottom(proxy: proxy, animated: false)
                    }
                }
                .onChange(of: viewModel.isSending) { _, isSending in
                    if isSending {
                        withAnimation(.easeOut(duration: 0.3)) {
                            proxy.scrollTo("step-indicator", anchor: .bottom)
                        }
                    }
                }
            }
            } // end else (messages non-empty)

            // Error banners
            if let sessionError = viewModel.sessionError {
                sessionErrorBanner(sessionError)
            } else if let errorText = viewModel.errorText {
                genericErrorBanner(errorText)
            }

            // Input bar
            InputBarView(
                text: $viewModel.inputText,
                isInputFocused: $isInputFocused,
                isGenerating: viewModel.isSending || viewModel.isThinking,
                isCancelling: viewModel.isCancelling,
                onSend: viewModel.sendMessage,
                onStop: viewModel.stopGenerating,
                onVoiceResult: { _ in
                    viewModel.pendingVoiceMessage = true
                    viewModel.sendMessage()
                },
                viewModel: viewModel
            )
        }
        .background(alignment: .bottom) { chatBackground }
        .background(VColor.chatBackground)
        .navigationTitle("Chat")
        .navigationBarTitleDisplayMode(.inline)
        .animation(.easeInOut(duration: 0.2), value: viewModel.sessionError != nil)
        .animation(.easeInOut(duration: 0.2), value: viewModel.errorText)
        .onChange(of: viewModel.messages.isEmpty) { _, isEmpty in
            if isEmpty {
                greeting = ["What are we working on?", "I'm here whenever you need me.",
                            "What's on your mind?", "Let's make something happen.",
                            "Ready when you are."].randomElement()!
            }
        }
    }

    // MARK: - Error Banners

    @ViewBuilder
    private func sessionErrorBanner(_ error: SessionError) -> some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: sessionErrorIcon(error.category))
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(sessionErrorAccent(error.category))

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(error.message)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(2)
                Text(error.recoverySuggestion)
                    .font(VFont.small)
                    .foregroundColor(VColor.textSecondary)
                    .lineLimit(1)
            }

            Spacer()

            if error.isRetryable {
                Button(action: { viewModel.retryAfterSessionError() }) {
                    Text("Retry")
                        .font(VFont.captionMedium)
                        .foregroundColor(.white)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(sessionErrorAccent(error.category))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
            }

            Button(action: { viewModel.dismissSessionError() }) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(VColor.textMuted)
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(sessionErrorAccent(error.category).opacity(0.1))
        .overlay(
            Rectangle()
                .fill(sessionErrorAccent(error.category))
                .frame(width: 3),
            alignment: .leading
        )
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    @ViewBuilder
    private func genericErrorBanner(_ errorText: String) -> some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(.white)
                .font(VFont.caption)
            Text(errorText)
                .font(VFont.caption)
                .foregroundColor(.white)
                .lineLimit(2)
            Spacer()
            if viewModel.isSecretBlockError {
                Button(action: { viewModel.sendAnyway() }) {
                    Text("Send Anyway")
                        .font(VFont.captionMedium)
                        .foregroundColor(.white)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(Color.white.opacity(0.25))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
            } else if viewModel.isRetryableError {
                Button(action: { viewModel.retryLastMessage() }) {
                    Text("Retry")
                        .font(VFont.captionMedium)
                        .foregroundColor(.white)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(Color.white.opacity(0.25))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
            }
            Button(action: { viewModel.dismissError() }) {
                Image(systemName: "xmark")
                    .font(VFont.caption)
                    .foregroundColor(.white)
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(VColor.error)
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    // MARK: - Helpers

    private func sessionErrorIcon(_ category: SessionErrorCategory) -> String {
        switch category {
        case .providerNetwork: return "wifi.exclamationmark"
        case .rateLimit: return "clock.badge.exclamationmark"
        case .providerApi: return "exclamationmark.icloud.fill"
        case .queueFull: return "tray.full.fill"
        case .sessionAborted: return "stop.circle.fill"
        case .processingFailed, .regenerateFailed: return "arrow.triangle.2.circlepath"
        case .unknown: return "exclamationmark.triangle.fill"
        }
    }

    private func sessionErrorAccent(_ category: SessionErrorCategory) -> Color {
        switch category {
        case .rateLimit, .queueFull: return VColor.warning
        case .providerNetwork: return .orange
        case .sessionAborted: return VColor.textSecondary
        default: return VColor.error
        }
    }

    // MARK: - Empty State

    private var emptyStateView: some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()
            Spacer()
            Image(systemName: "sparkles")
                .font(.system(size: 48, weight: .thin))
                .foregroundColor(VColor.accent)
                .opacity(emptyStateVisible ? 1 : 0)
                .scaleEffect(emptyStateVisible ? 1 : 0.8)
            Text(greeting)
                .font(.system(size: 22, weight: .medium))
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)
                .opacity(emptyStateVisible ? 1 : 0)
                .offset(y: emptyStateVisible ? 0 : 8)
                .padding(.horizontal, VSpacing.xl)
            Spacer()
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            RadialGradient(
                gradient: Gradient(colors: [
                    VColor.accent.opacity(0.07),
                    VColor.accent.opacity(0.02),
                    Color.clear,
                ]),
                center: .center,
                startRadius: 20,
                endRadius: 350
            )
            .offset(y: -40)
            .opacity(emptyStateVisible ? 1 : 0)
        )
        .onAppear {
            withAnimation(.easeOut(duration: 0.5)) {
                emptyStateVisible = true
            }
        }
        .onDisappear {
            emptyStateVisible = false
        }
    }

    // MARK: - Chat Background

    @ViewBuilder
    private var chatBackground: some View {
        if colorScheme == .dark, let uiImage = chatBackgroundImage {
            Image(uiImage: uiImage)
                .resizable()
                .scaledToFit()
                .allowsHitTesting(false)
        }
    }

    private func scrollToBottom(proxy: ScrollViewProxy, animated: Bool) {
        guard let lastMessage = viewModel.messages.last else { return }
        if animated {
            withAnimation(.easeOut(duration: 0.3)) {
                proxy.scrollTo(lastMessage.id, anchor: .bottom)
            }
        } else {
            proxy.scrollTo(lastMessage.id, anchor: .bottom)
        }
    }
}

#endif
