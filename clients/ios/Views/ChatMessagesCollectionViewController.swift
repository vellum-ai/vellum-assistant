#if canImport(UIKit)
import SwiftUI
import UIKit
import VellumAssistantShared

/// Hosts the chat `UICollectionView` and owns every piece of controller-side
/// state: structural snapshot, scroll positioning, auto-follow engagement,
/// pagination, pending-anchor resolution, and visibility reporting. Row content
/// lives in `ChatMessagesCollectionCells.swift` and is wired in through
/// `UIHostingConfiguration`.
final class ChatMessagesCollectionViewController: UIViewController {
    private var viewModel: ChatViewModel
    var onForkFromMessage: ((String) -> Void)?
    var onPendingAnchorHandled: ((UUID) -> Void)?
    var onVisibilityStateChanged: (_ isNearBottom: Bool, _ contentExceedsViewport: Bool) -> Void

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
    /// Tracks the previous `viewModel.isSending` value so we can detect the
    /// `false -> true` transition and re-engage auto-follow when the user
    /// sends a new message (matching iMessage/WhatsApp behaviour).
    private var lastIsSending: Bool = false

    /// Observation handle used to rebuild the snapshot whenever any observed
    /// property on `ChatViewModel` (or the managers it forwards to) changes.
    /// Re-armed after every tracked read.
    private var observationRearmToken: UUID = UUID()
    /// Coalescing handle for `rebuildSnapshot` — at most one rebuild per
    /// `rebuildCoalescingWindowNanos` window is actually applied, so
    /// per-token `@Observable` firings during streaming don't drive
    /// unbounded diff churn. See `clients/AGENTS.md` → "Coalesce
    /// high-frequency Combine publishes" (100 ms minimum default).
    private var pendingRebuildTask: Task<Void, Never>?
    private static let rebuildCoalescingWindowNanos: UInt64 = 100_000_000
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
        pendingRebuildTask?.cancel()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        configureCollectionView()
        configureDataSource()
        view.backgroundColor = .clear
        collectionView.backgroundColor = .clear
        lastConversationId = .some(viewModel.conversationId)
        lastIsSending = viewModel.isSending
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
            case .queuedMarker:
                return collectionView.dequeueConfiguredReusableCell(using: queuedMarkerReg, for: indexPath, item: ())
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

    private func makeQueuedMarkerRegistration() -> UICollectionView.CellRegistration<UICollectionViewListCell, Void> {
        UICollectionView.CellRegistration<UICollectionViewListCell, Void> { [weak self] cell, _, _ in
            guard let self else { return }
            cell.contentConfiguration = UIHostingConfiguration {
                QueuedMarkerCellContent(viewModel: self.viewModel)
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
                self.scheduleCoalescedRebuild()
                self.observeViewModel()
            }
        }
    }

    /// Schedules a `rebuildSnapshot` at most once per coalescing window.
    /// Streaming text updates fire `@Observable` tracking on every token;
    /// without coalescing each fire runs the full diff + apply pipeline
    /// even though row identities haven't changed.
    private func scheduleCoalescedRebuild() {
        guard pendingRebuildTask == nil else { return }
        pendingRebuildTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.rebuildCoalescingWindowNanos)
            guard let self, !Task.isCancelled else { return }
            self.pendingRebuildTask = nil
            self.rebuildSnapshot(animated: false)
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
            case .queuedMarker:
                items.append(.queuedMarker)
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
        // Cancel any pending coalesced rebuild — we're rebuilding now, so a
        // queued one would be redundant.
        pendingRebuildTask?.cancel()
        pendingRebuildTask = nil
        let snapshot = buildSnapshot()

        // When the user sends a new message (`isSending` flips false -> true),
        // re-engage auto-follow so the sent message and streaming response
        // appear on-screen — even if the user had scrolled up to read earlier
        // history. Matches iMessage/WhatsApp send behaviour. Skip while a
        // pending-anchor (deep-link / fork) resolution is active so we don't
        // yank the user off the historical anchor.
        let isSendingNow = viewModel.isSending
        if isSendingNow && !lastIsSending && lastPendingAnchorRequestId == nil {
            shouldAutoFollow = true
        }
        lastIsSending = isSendingNow

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
                // Non-animated to match the legacy `ScrollView` behaviour on
                // streaming updates — animating every token produces subtle
                // jitter when already pinned at the bottom. The first-time
                // initial scroll also lands non-animated, handled below.
                self.scrollToLatestItem(animated: false)
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
            lastIsSending = viewModel.isSending
            pendingAnchorTask?.cancel()
            observeViewModel()
            rebuildSnapshot(animated: false)
        }

        let currentConversationId: String? = viewModel.conversationId
        if case .some(let previous) = lastConversationId, previous != currentConversationId {
            hasPerformedInitialScroll = false
            shouldAutoFollow = true
            isPaginationInFlight = false
            lastIsSending = viewModel.isSending
        }
        lastConversationId = .some(currentConversationId)

        // Handle explicit "scroll to latest" taps from the overlay button.
        // `snapWindowToLatest()` mutates `paginatedVisibleMessages`, which
        // fires observation and schedules an asynchronous rebuild. Scrolling
        // immediately would target the pre-snap snapshot; rebuilding
        // synchronously ensures the snapshot reflects the post-snap window
        // before the `wasAutoFollowing` branch in `rebuildSnapshot` performs
        // the scroll.
        if scrollToLatestTrigger != lastScrollToLatestTrigger {
            lastScrollToLatestTrigger = scrollToLatestTrigger
            shouldAutoFollow = true
            viewModel.snapWindowToLatest()
            rebuildSnapshot(animated: false)
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
        // `[weak self]` is re-resolved inside the loop so the strong binding
        // is scoped to a single iteration. Without this, the outer
        // `guard let self` would pin `self` for the lifetime of the task;
        // because the task is stored on `self` (`pendingAnchorTask`), that
        // forms a retain cycle that blocks `deinit` and prevents cancellation.
        pendingAnchorTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
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
                    // Wait for the load to complete, then fall through to
                    // the next outer iteration (which re-resolves weak self).
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

/// Shared background config used by every cell. `nil` color removes the default
/// system list row background, which clashes with the chat backdrop.
private func clearBackground() -> UIBackgroundConfiguration {
    var config = UIBackgroundConfiguration.listPlainCell()
    config.backgroundColor = .clear
    return config
}
#endif
