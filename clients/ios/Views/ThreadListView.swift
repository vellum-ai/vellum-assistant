#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// MARK: - IOSThread

/// Represents a single local chat thread on iOS.
struct IOSThread: Identifiable {
    let id: UUID
    var title: String

    init(id: UUID = UUID(), title: String = "New Chat") {
        self.id = id
        self.title = title
    }
}

// MARK: - IOSThreadStore

/// Manages a list of local in-memory chat threads for iOS.
/// Each thread owns an independent ChatViewModel instance so threads
/// do not share message history or sending state.
@MainActor
class IOSThreadStore: ObservableObject {
    @Published var threads: [IOSThread] = []

    /// ViewModels keyed by thread ID, created lazily on first access.
    private var viewModels: [UUID: ChatViewModel] = [:]
    private let daemonClient: DaemonClient

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
        // Start with one default thread.
        newThread()
    }

    /// Return the ChatViewModel for the given thread, creating it if necessary.
    func viewModel(for threadId: UUID) -> ChatViewModel {
        if let existing = viewModels[threadId] {
            return existing
        }
        let vm = ChatViewModel(daemonClient: daemonClient)
        viewModels[threadId] = vm
        return vm
    }

    func newThread() {
        let thread = IOSThread()
        threads.append(thread)
    }

    func deleteThread(_ thread: IOSThread) {
        viewModels.removeValue(forKey: thread.id)
        threads.removeAll { $0.id == thread.id }
        // Always keep at least one thread.
        if threads.isEmpty {
            newThread()
        }
    }
}

// MARK: - ThreadListView

struct ThreadListView: View {
    @EnvironmentObject private var daemonClient: DaemonClient
    @StateObject private var store: IOSThreadStore
    @State private var selectedThreadId: UUID?

    init() {
        // Store is initialised with a temporary placeholder; the real
        // daemonClient is injected via onAppear once the environment is set.
        // However, @StateObject is only created once, so we use a workaround:
        // capture the store creation inside a lazy init via _store assignment.
        // The actual daemonClient is set in `makeStore` via the environment.
        // Because @StateObject wrappedValue must be set at init time we defer
        // to the factory pattern below.
        _store = StateObject(wrappedValue: IOSThreadStore(daemonClient: DaemonClient(config: .fromUserDefaults())))
    }

    /// Designated factory initialiser used by ContentView so the correct
    /// DaemonClient is passed before the SwiftUI environment is available.
    init(daemonClient: DaemonClient) {
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

    var body: some View {
        VStack(spacing: 0) {
            // Messages list
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: VSpacing.md) {
                        ForEach(viewModel.messages) { message in
                            MessageBubbleView(
                                message: message,
                                onConfirmationResponse: { requestId, decision in
                                    viewModel.respondToConfirmation(requestId: requestId, decision: decision)
                                },
                                onSurfaceAction: { surfaceId, actionId, data in
                                    viewModel.sendSurfaceAction(surfaceId: surfaceId, actionId: actionId, data: data)
                                },
                                onRegenerate: viewModel.isSending ? nil : { viewModel.regenerateLastMessage() }
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
                },
                viewModel: viewModel
            )
        }
        .background(VColor.background)
        .navigationTitle("Chat")
        .navigationBarTitleDisplayMode(.inline)
        .animation(.easeInOut(duration: 0.2), value: viewModel.sessionError != nil)
        .animation(.easeInOut(duration: 0.2), value: viewModel.errorText)
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
            if viewModel.isRetryableError {
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
