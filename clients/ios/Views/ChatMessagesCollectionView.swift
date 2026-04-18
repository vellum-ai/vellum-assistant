#if canImport(UIKit)
import SwiftUI
import UIKit
import VellumAssistantShared

/// Stable identifier for a row in the chat list. Used as the `ItemIdentifierType`
/// of `UICollectionViewDiffableDataSource` — only *structural* changes drive
/// diffs, while per-cell SwiftUI content updates through `@Observable` tracking
/// on `ChatViewModel`. Every case's associated value is a stable identity (a
/// message UUID, a subagent id string, or nothing for single-instance rows).
enum ChatListItem: Hashable {
    case paginationHeader
    case queuedMarker(count: Int)
    case message(UUID)
    case orphanSubagent(String)
    case typingIndicator
}

/// UIKit-backed chat message list.
///
/// Replaces the `ScrollView { LazyVStack { ... } }` + `ScrollViewProxy.scrollTo`
/// pattern, which is unreliable on iOS 17: `LazyVStack` only materializes visible
/// rows so `scrollTo(_:anchor:)` targets an estimated, non-materialized position
/// and produces blank frames or partial scrolls on re-entry and streaming
/// (see [Apple Developer Forums #741406](https://developer.apple.com/forums/thread/741406)).
///
/// `UICollectionView` + `UICollectionViewDiffableDataSource` gives deterministic
/// scroll targets via `scrollToItem(at:at:animated:)` regardless of which rows
/// have been materialized, a first-class "prepend older page without jump"
/// contract via captured `contentSize`, and interactive keyboard dismissal that
/// matches iMessage. Cells host existing SwiftUI chat views via
/// [`UIHostingConfiguration`](https://developer.apple.com/documentation/uikit/uihostingconfiguration)
/// (WWDC23), so row content is unchanged from the previous SwiftUI
/// implementation.
struct ChatMessagesCollectionView: UIViewControllerRepresentable {
    var viewModel: ChatViewModel
    var pendingAnchorRequestId: UUID?
    var pendingAnchorDaemonMessageId: String?
    var scrollToLatestTrigger: Int
    var onPendingAnchorHandled: ((UUID) -> Void)?
    var onForkFromMessage: ((String) -> Void)?
    var onVisibilityStateChanged: (_ isNearBottom: Bool, _ contentExceedsViewport: Bool) -> Void

    func makeUIViewController(context: Context) -> ChatMessagesCollectionViewController {
        ChatMessagesCollectionViewController(
            viewModel: viewModel,
            onForkFromMessage: onForkFromMessage,
            onPendingAnchorHandled: onPendingAnchorHandled,
            onVisibilityStateChanged: onVisibilityStateChanged
        )
    }

    func updateUIViewController(_ controller: ChatMessagesCollectionViewController, context: Context) {
        controller.onForkFromMessage = onForkFromMessage
        controller.onPendingAnchorHandled = onPendingAnchorHandled
        controller.onVisibilityStateChanged = onVisibilityStateChanged
        controller.syncFromSwiftUI(
            viewModel: viewModel,
            pendingAnchorRequestId: pendingAnchorRequestId,
            pendingAnchorDaemonMessageId: pendingAnchorDaemonMessageId,
            scrollToLatestTrigger: scrollToLatestTrigger
        )
    }
}

// MARK: - Controller

final class ChatMessagesCollectionViewController: UIViewController {
    private var viewModel: ChatViewModel
    fileprivate var onForkFromMessage: ((String) -> Void)?
    fileprivate var onPendingAnchorHandled: ((UUID) -> Void)?
    fileprivate var onVisibilityStateChanged: (_ isNearBottom: Bool, _ contentExceedsViewport: Bool) -> Void

    private var collectionView: UICollectionView!
    private var dataSource: UICollectionViewDiffableDataSource<Int, ChatListItem>!

    /// Tokens used to detect prop changes between `updateUIViewController` calls.
    private var lastConversationId: String??
    private var lastPendingAnchorRequestId: UUID?
    private var lastScrollToLatestTrigger: Int = 0

    /// Whether auto-follow (scroll with new content) is engaged. Flipped to false
    /// the moment the user scrolls up by any amount; re-engaged only when the
    /// user scrolls back to the bottom or taps "Scroll to latest".
    private var shouldAutoFollow: Bool = true
    /// Whether the user has started an interactive scroll since the last
    /// programmatic scroll. Used to ignore programmatic contentOffset changes
    /// when updating `shouldAutoFollow`.
    private var isUserInteracting: Bool = false
    /// Set while applying a snapshot + doing a programmatic scroll so we don't
    /// re-classify the programmatic movement as a user scroll.
    private var isApplyingSnapshot: Bool = false
    /// Set once the controller has performed the initial bottom scroll for the
    /// current conversation. Reset on conversationId change.
    private var hasPerformedInitialScroll: Bool = false
    /// True while a pagination load is in flight; used to preserve scroll
    /// position when older messages are prepended.
    private var isPaginationInFlight: Bool = false

    /// Observation handle used to rebuild the snapshot whenever any observed
    /// property on `ChatViewModel` (or the managers it forwards to) changes.
    /// Re-armed after every tracked read.
    private var observationRearmToken: UUID = UUID()
    private var pendingAnchorTask: Task<Void, Never>?

    init(
        viewModel: ChatViewModel,
        onForkFromMessage: ((String) -> Void)?,
        onPendingAnchorHandled: ((UUID) -> Void)?,
        onVisibilityStateChanged: @escaping (_ isNearBottom: Bool, _ contentExceedsViewport: Bool) -> Void
    ) {
        self.viewModel = viewModel
        self.onForkFromMessage = onForkFromMessage
        self.onPendingAnchorHandled = onPendingAnchorHandled
        self.onVisibilityStateChanged = onVisibilityStateChanged
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        pendingAnchorTask?.cancel()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        configureCollectionView()
        configureDataSource()
        view.backgroundColor = .clear
        collectionView.backgroundColor = .clear
        lastConversationId = .some(viewModel.conversationId)
        observeViewModel()
        rebuildSnapshot(animated: false)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Re-entering the same conversation without an identity change means
        // `updateUIViewController` won't trigger an initial scroll. Guarantee
        // we land on the latest row on every appearance when auto-following.
        if shouldAutoFollow {
            scrollToLatestItem(animated: false)
        }
    }

    private func configureCollectionView() {
        var config = UICollectionLayoutListConfiguration(appearance: .plain)
        config.showsSeparators = false
        config.backgroundColor = .clear
        let layout = UICollectionViewCompositionalLayout.list(using: config)

        collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
        collectionView.translatesAutoresizingMaskIntoConstraints = false
        collectionView.delegate = self
        collectionView.keyboardDismissMode = .interactive
        collectionView.contentInsetAdjustmentBehavior = .always
        collectionView.alwaysBounceVertical = true
        collectionView.allowsSelection = false
        collectionView.contentInset = UIEdgeInsets(top: VSpacing.lg, left: 0, bottom: VSpacing.lg, right: 0)

        view.addSubview(collectionView)
        NSLayoutConstraint.activate([
            collectionView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            collectionView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            collectionView.topAnchor.constraint(equalTo: view.topAnchor),
            collectionView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    // MARK: - Data source

    private func configureDataSource() {
        let paginationHeaderReg = makePaginationHeaderRegistration()
        let queuedMarkerReg = makeQueuedMarkerRegistration()
        let messageReg = makeMessageRegistration()
        let orphanSubagentReg = makeOrphanSubagentRegistration()
        let typingIndicatorReg = makeTypingIndicatorRegistration()

        dataSource = UICollectionViewDiffableDataSource<Int, ChatListItem>(
            collectionView: collectionView
        ) { collectionView, indexPath, item in
            switch item {
            case .paginationHeader:
                return collectionView.dequeueConfiguredReusableCell(using: paginationHeaderReg, for: indexPath, item: ())
            case .queuedMarker(let count):
                return collectionView.dequeueConfiguredReusableCell(using: queuedMarkerReg, for: indexPath, item: count)
            case .message(let id):
                return collectionView.dequeueConfiguredReusableCell(using: messageReg, for: indexPath, item: id)
            case .orphanSubagent(let id):
                return collectionView.dequeueConfiguredReusableCell(using: orphanSubagentReg, for: indexPath, item: id)
            case .typingIndicator:
                return collectionView.dequeueConfiguredReusableCell(using: typingIndicatorReg, for: indexPath, item: ())
            }
        }
    }

    private func makePaginationHeaderRegistration() -> UICollectionView.CellRegistration<UICollectionViewListCell, Void> {
        UICollectionView.CellRegistration<UICollectionViewListCell, Void> { [weak self] cell, _, _ in
            guard let self else { return }
            cell.contentConfiguration = UIHostingConfiguration {
                PaginationHeaderCellContent(
                    viewModel: self.viewModel,
                    onRequestLoadMore: { [weak self] in
                        self?.requestPaginationLoad()
                    }
                )
            }
            .margins(.all, 0)
            cell.backgroundConfiguration = clearBackground()
        }
    }

    private func makeQueuedMarkerRegistration() -> UICollectionView.CellRegistration<UICollectionViewListCell, Int> {
        UICollectionView.CellRegistration<UICollectionViewListCell, Int> { cell, _, count in
            cell.contentConfiguration = UIHostingConfiguration {
                QueuedMessagesMarker_iOS(count: count)
            }
            .margins(.horizontal, VSpacing.lg)
            .margins(.vertical, VSpacing.sm)
            cell.backgroundConfiguration = clearBackground()
        }
    }

    private func makeMessageRegistration() -> UICollectionView.CellRegistration<UICollectionViewListCell, UUID> {
        UICollectionView.CellRegistration<UICollectionViewListCell, UUID> { [weak self] cell, _, id in
            guard let self else { return }
            cell.contentConfiguration = UIHostingConfiguration {
                MessageCellContent(
                    viewModel: self.viewModel,
                    messageId: id,
                    onForkFromMessage: self.onForkFromMessage
                )
            }
            .margins(.horizontal, VSpacing.lg)
            .margins(.vertical, VSpacing.sm)
            cell.backgroundConfiguration = clearBackground()
        }
    }

    private func makeOrphanSubagentRegistration() -> UICollectionView.CellRegistration<UICollectionViewListCell, String> {
        UICollectionView.CellRegistration<UICollectionViewListCell, String> { [weak self] cell, _, id in
            guard let self else { return }
            cell.contentConfiguration = UIHostingConfiguration {
                OrphanSubagentCellContent(viewModel: self.viewModel, subagentId: id)
            }
            .margins(.horizontal, VSpacing.lg)
            .margins(.vertical, VSpacing.sm)
            cell.backgroundConfiguration = clearBackground()
        }
    }

    private func makeTypingIndicatorRegistration() -> UICollectionView.CellRegistration<UICollectionViewListCell, Void> {
        UICollectionView.CellRegistration<UICollectionViewListCell, Void> { [weak self] cell, _, _ in
            guard let self else { return }
            cell.contentConfiguration = UIHostingConfiguration {
                TypingIndicatorCellContent(viewModel: self.viewModel)
            }
            .margins(.horizontal, 0)
            .margins(.vertical, VSpacing.sm)
            cell.backgroundConfiguration = clearBackground()
        }
    }

    // MARK: - Observation

    /// Observes any read from `viewModel` (via `@Observable` tracking through
    /// the SwiftUI `@Bindable` binding surface) and rebuilds the diffable
    /// snapshot when any relevant property changes. Re-arms after every fire
    /// so tracking continues across subsequent mutations.
    private func observeViewModel() {
        let token = UUID()
        observationRearmToken = token
        withObservationTracking {
            // Read every property the snapshot depends on.
            _ = viewModel.paginatedVisibleMessages
            _ = viewModel.activeSubagents
            _ = viewModel.queuedMessages.count
            _ = viewModel.isSending
            _ = viewModel.hasPendingConfirmation
            _ = viewModel.hasMoreMessages
            _ = viewModel.isLoadingMoreMessages
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.observationRearmToken == token else { return }
                self.rebuildSnapshot(animated: false)
                self.observeViewModel()
            }
        }
    }

    // MARK: - Snapshot

    private func buildSnapshot() -> NSDiffableDataSourceSnapshot<Int, ChatListItem> {
        var snapshot = NSDiffableDataSourceSnapshot<Int, ChatListItem>()
        snapshot.appendSections([0])

        var items: [ChatListItem] = []

        if viewModel.hasMoreMessages || viewModel.isLoadingMoreMessages {
            items.append(.paginationHeader)
        }

        let transcriptItems = TranscriptItems.build(from: viewModel.paginatedVisibleMessages)
        for item in transcriptItems {
            switch item {
            case .queuedMarker(let count):
                items.append(.queuedMarker(count: count))
            case .message(let message):
                items.append(.message(message.id))
            }
        }

        for subagent in viewModel.activeSubagents where subagent.parentMessageId == nil {
            items.append(.orphanSubagent(subagent.id))
        }

        if viewModel.isSending && !viewModel.hasPendingConfirmation {
            items.append(.typingIndicator)
        }

        snapshot.appendItems(items, toSection: 0)
        return snapshot
    }

    private func rebuildSnapshot(animated: Bool) {
        guard isViewLoaded, dataSource != nil else { return }
        let snapshot = buildSnapshot()
        let wasAutoFollowing = shouldAutoFollow
        let heightBefore = collectionView.contentSize.height
        let offsetBefore = collectionView.contentOffset
        let isPaginating = isPaginationInFlight

        isApplyingSnapshot = true
        dataSource.apply(snapshot, animatingDifferences: animated) { [weak self] in
            guard let self else { return }
            if isPaginating {
                // Older messages were prepended: keep the visible row steady by
                // shifting the offset by the delta in total content height.
                let heightAfter = self.collectionView.contentSize.height
                let delta = heightAfter - heightBefore
                if delta > 0 {
                    self.collectionView.setContentOffset(
                        CGPoint(x: offsetBefore.x, y: offsetBefore.y + delta),
                        animated: false
                    )
                }
            } else if wasAutoFollowing {
                self.scrollToLatestItem(animated: self.hasPerformedInitialScroll)
            }
            self.isApplyingSnapshot = false
            self.updateVisibilityState()
            if !self.hasPerformedInitialScroll, !snapshot.itemIdentifiers.isEmpty {
                self.scrollToLatestItem(animated: false)
                self.hasPerformedInitialScroll = true
            }
        }
    }

    // MARK: - SwiftUI sync

    func syncFromSwiftUI(
        viewModel: ChatViewModel,
        pendingAnchorRequestId: UUID?,
        pendingAnchorDaemonMessageId: String?,
        scrollToLatestTrigger: Int
    ) {
        // SwiftUI may re-invoke the representable with a different ChatViewModel
        // instance (e.g. a conversation switch that reuses the same detail
        // view). Rebind the stored reference and re-arm observation so snapshot
        // generation and observation read from the current model.
        let viewModelChanged = ObjectIdentifier(viewModel) != ObjectIdentifier(self.viewModel)
        if viewModelChanged {
            self.viewModel = viewModel
            hasPerformedInitialScroll = false
            shouldAutoFollow = true
            isPaginationInFlight = false
            pendingAnchorTask?.cancel()
            observeViewModel()
            rebuildSnapshot(animated: false)
        }

        let currentConversationId: String? = viewModel.conversationId
        if case .some(let previous) = lastConversationId, previous != currentConversationId {
            hasPerformedInitialScroll = false
            shouldAutoFollow = true
            isPaginationInFlight = false
        }
        lastConversationId = .some(currentConversationId)

        // Handle explicit "scroll to latest" taps from the overlay button.
        if scrollToLatestTrigger != lastScrollToLatestTrigger {
            lastScrollToLatestTrigger = scrollToLatestTrigger
            viewModel.snapWindowToLatest()
            shouldAutoFollow = true
            scrollToLatestItem(animated: true)
        }

        // Restart pending-anchor resolution when the request id changes.
        if pendingAnchorRequestId != lastPendingAnchorRequestId {
            lastPendingAnchorRequestId = pendingAnchorRequestId
            pendingAnchorTask?.cancel()
            if let requestId = pendingAnchorRequestId,
               let daemonMessageId = pendingAnchorDaemonMessageId {
                startPendingAnchorResolution(requestId: requestId, daemonMessageId: daemonMessageId)
            }
        }
    }

    // MARK: - Pagination

    private func requestPaginationLoad() {
        guard !isPaginationInFlight else { return }
        isPaginationInFlight = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            _ = await self.viewModel.loadPreviousMessagePage()
            self.isPaginationInFlight = false
        }
    }

    // MARK: - Pending anchor resolution

    private func startPendingAnchorResolution(requestId: UUID, daemonMessageId: String) {
        pendingAnchorTask = Task { @MainActor [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                guard self.viewModel.isHistoryLoaded else {
                    try? await Task.sleep(nanoseconds: 50_000_000)
                    continue
                }

                switch nextPendingChatAnchorSearchStep(
                    daemonMessageId: daemonMessageId,
                    displayedMessages: self.viewModel.displayedMessages,
                    paginatedVisibleMessages: self.viewModel.paginatedVisibleMessages,
                    hasMoreMessages: self.viewModel.hasMoreMessages
                ) {
                case let .scroll(localMessageId):
                    // Clear auto-follow so subsequent streaming/snapshot
                    // rebuilds don't yank the user back to the bottom after
                    // landing on a historical anchor.
                    self.shouldAutoFollow = false
                    self.scrollToMessage(id: localMessageId, animated: true)
                    self.onPendingAnchorHandled?(requestId)
                    return
                case .loadOlderPage:
                    if self.viewModel.isLoadingMoreMessages {
                        try? await Task.sleep(nanoseconds: 50_000_000)
                        continue
                    }
                    let startedLoading = await self.viewModel.loadPreviousMessagePage()
                    guard startedLoading else {
                        self.onPendingAnchorHandled?(requestId)
                        return
                    }
                    // Wait for the load to complete, then retry on next loop.
                    while self.viewModel.isLoadingMoreMessages && !Task.isCancelled {
                        try? await Task.sleep(nanoseconds: 50_000_000)
                    }
                case .snapToLatest:
                    self.viewModel.snapWindowToLatest()
                    try? await Task.sleep(nanoseconds: 50_000_000)
                case .consume:
                    self.onPendingAnchorHandled?(requestId)
                    return
                }
            }
        }
    }

    // MARK: - Scrolling

    private func scrollToLatestItem(animated: Bool) {
        guard let snapshot = dataSource?.snapshot() else { return }
        let count = snapshot.numberOfItems
        guard count > 0 else { return }
        let indexPath = IndexPath(item: count - 1, section: 0)
        collectionView.scrollToItem(at: indexPath, at: .bottom, animated: animated)
    }

    private func scrollToMessage(id: UUID, animated: Bool) {
        guard let indexPath = dataSource?.indexPath(for: .message(id)) else { return }
        collectionView.scrollToItem(at: indexPath, at: .centeredVertically, animated: animated)
    }

    // MARK: - Visibility state

    /// Updates SwiftUI's cached `isNearBottom` / `contentExceedsViewport` flags
    /// which drive the "Scroll to latest" overlay button visibility.
    private func updateVisibilityState() {
        let contentHeight = collectionView.contentSize.height
        let viewportHeight = collectionView.bounds.height
        let inset = collectionView.adjustedContentInset
        let offsetY = collectionView.contentOffset.y
        let distanceFromBottom = (contentHeight + inset.bottom) - (offsetY + viewportHeight)
        let isNearBottom = distanceFromBottom <= 2.0
        let contentExceedsViewport = contentHeight + inset.top + inset.bottom > viewportHeight + 2.0
        onVisibilityStateChanged(isNearBottom, contentExceedsViewport)
    }
}

// MARK: - UIScrollViewDelegate

extension ChatMessagesCollectionViewController: UICollectionViewDelegate {
    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        isUserInteracting = true
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate {
            isUserInteracting = false
        }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        isUserInteracting = false
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        // Update auto-follow based on the user's position only when the user is
        // actively dragging/decelerating. Programmatic scrolls (initial scroll,
        // auto-follow scroll, pending-anchor scroll) must not reset the flag.
        guard isUserInteracting else {
            updateVisibilityState()
            return
        }
        let contentHeight = scrollView.contentSize.height
        let viewportHeight = scrollView.bounds.height
        let inset = scrollView.adjustedContentInset
        let offsetY = scrollView.contentOffset.y
        let distanceFromBottom = (contentHeight + inset.bottom) - (offsetY + viewportHeight)
        shouldAutoFollow = distanceFromBottom <= 2.0
        updateVisibilityState()
    }
}

// MARK: - Cell SwiftUI content

/// Shared background config used by every cell. `nil` color removes the default
/// system list row background, which clashes with the chat backdrop.
private func clearBackground() -> UIBackgroundConfiguration {
    var config = UIBackgroundConfiguration.listPlainCell()
    config.backgroundColor = .clear
    return config
}

private struct PaginationHeaderCellContent: View {
    @Bindable var viewModel: ChatViewModel
    var onRequestLoadMore: () -> Void

    var body: some View {
        Group {
            if viewModel.isLoadingMoreMessages {
                HStack {
                    Spacer()
                    VLoadingIndicator(size: 18)
                    Spacer()
                }
                .padding(.vertical, VSpacing.sm)
            } else if viewModel.hasMoreMessages {
                Color.clear
                    .frame(height: 1)
                    .onAppear(perform: onRequestLoadMore)
            }
        }
    }
}

private struct MessageCellContent: View {
    @Bindable var viewModel: ChatViewModel
    let messageId: UUID
    let onForkFromMessage: ((String) -> Void)?

    var body: some View {
        let messages = viewModel.paginatedVisibleMessages
        if let index = messages.firstIndex(where: { $0.id == messageId }) {
            let message = messages[index]
            VStack(alignment: .leading, spacing: VSpacing.md) {
                bubble(for: message, index: index, messages: messages)
                ForEach(viewModel.activeSubagents.filter { $0.parentMessageId == message.id }) { subagent in
                    SubagentStatusChip(subagent: subagent)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    @ViewBuilder
    private func bubble(for message: ChatMessage, index: Int, messages: [ChatMessage]) -> some View {
        if message.modelList != nil {
            ModelListBubble(
                currentModel: viewModel.selectedModel,
                configuredProviders: viewModel.configuredProviders,
                providerCatalog: viewModel.providerCatalog
            )
        } else if message.commandList != nil {
            commandListBubble(message: message, index: index, messages: messages)
        } else {
            regularMessageBubble(message: message, index: index, messages: messages)
        }
    }

    @ViewBuilder
    private func commandListBubble(message: ChatMessage, index: Int, messages: [ChatMessage]) -> some View {
        if let parsedEntries = CommandListBubble.parsedEntries(from: message.text) {
            CommandListBubble(commands: parsedEntries)
        } else {
            var fallback = message
            let _ = (fallback.commandList = nil)
            regularMessageBubble(message: fallback, index: index, messages: messages)
        }
    }

    @ViewBuilder
    private func regularMessageBubble(message: ChatMessage, index: Int, messages: [ChatMessage]) -> some View {
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
            onRegenerate: isLastAssistant ? { viewModel.regenerateLastMessage() } : nil,
            onAlwaysAllow: { requestId, selectedPattern, selectedScope, decision in
                viewModel.respondToAlwaysAllow(requestId: requestId, selectedPattern: selectedPattern, selectedScope: selectedScope, decision: decision)
            },
            onGuardianAction: { requestId, action in
                viewModel.submitGuardianDecision(requestId: requestId, action: action)
            },
            onSurfaceRefetch: { surfaceId, conversationId in
                viewModel.refetchStrippedSurface(surfaceId: surfaceId, conversationId: conversationId)
            },
            onRetryConversationError: message.isError && index == messages.count - 1 ? { viewModel.retryAfterConversationError() } : nil,
            onForkFromMessage: onForkFromMessage
        )

        if !message.text.isEmpty && !message.isStreaming {
            MessageMediaEmbedsView(message: message)
        }
    }
}

private struct OrphanSubagentCellContent: View {
    @Bindable var viewModel: ChatViewModel
    let subagentId: String

    var body: some View {
        if let subagent = viewModel.activeSubagents.first(where: { $0.id == subagentId }) {
            SubagentStatusChip(subagent: subagent)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct TypingIndicatorCellContent: View {
    @Bindable var viewModel: ChatViewModel

    var body: some View {
        let lastMessage = viewModel.messages.last
        let allToolCalls = lastMessage?.toolCalls ?? []
        let isStreaming = lastMessage?.isStreaming == true
        let hasActiveToolCall = allToolCalls.contains { !$0.isComplete }
        let isStreamingWithoutText = isStreaming && (lastMessage?.text.isEmpty ?? true)

        if !isStreaming && !hasActiveToolCall {
            HStack {
                TypingIndicatorView()
                if let statusText = viewModel.assistantStatusText, !statusText.isEmpty {
                    Text(statusText)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
                Spacer()
            }
            .padding(.horizontal, VSpacing.lg)
        } else if hasActiveToolCall {
            CurrentStepIndicator(
                toolCalls: allToolCalls,
                isStreaming: viewModel.isSending,
                onTap: {}
            )
            .padding(.horizontal, VSpacing.lg)
        } else if isStreamingWithoutText {
            HStack {
                TypingIndicatorView()
                Spacer()
            }
            .padding(.horizontal, VSpacing.lg)
        } else if viewModel.isThinking {
            HStack {
                TypingIndicatorView()
                if let statusText = viewModel.assistantStatusText, !statusText.isEmpty {
                    Text(statusText)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
                Spacer()
            }
            .padding(.horizontal, VSpacing.lg)
        }
    }
}
#endif
