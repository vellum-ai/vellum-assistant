#if canImport(UIKit)
import SwiftUI
import UIKit
import VellumAssistantShared

/// Stable identifier for a row in the chat list. Used as the `ItemIdentifierType`
/// of [`UICollectionViewDiffableDataSource`](https://developer.apple.com/documentation/uikit/uicollectionviewdiffabledatasource)
/// so only *structural* changes drive diffs, while per-cell SwiftUI content
/// updates through `@Observable` tracking on `ChatViewModel`. Each associated
/// value is a stable identity (a message UUID, a subagent id string, or
/// nothing for single-instance rows). The queued-marker row is a singleton —
/// its cell reads `queuedMessages.count` directly from the view model so queue
/// mutations update the displayed count without invalidating the row's
/// diffable identity.
enum ChatListItem: Hashable {
    case paginationHeader
    case queuedMarker
    case message(UUID)
    case orphanSubagent(String)
    case typingIndicator
}

/// UIKit-backed chat message list.
///
/// Backed by [`UICollectionView`](https://developer.apple.com/documentation/uikit/uicollectionview)
/// and [`UICollectionViewDiffableDataSource`](https://developer.apple.com/documentation/uikit/uicollectionviewdiffabledatasource)
/// so scroll targets are deterministic regardless of which rows have been
/// materialized: `scrollToItem(at:at:animated:)` works on any index, not just
/// realized cells. This is required for the chat UX contracts — "scroll to
/// the latest message on streaming updates", "restore position when older
/// pages are prepended", and "scroll to a specific historical message on a
/// deep link / fork resolution" — which all depend on being able to target
/// non-visible rows reliably.
///
/// Row content is rendered as SwiftUI hosted inside list cells via
/// [`UIHostingConfiguration`](https://developer.apple.com/documentation/uikit/uihostingconfiguration)
/// (WWDC23: [What's new in UIKit](https://developer.apple.com/videos/play/wwdc2023/10055/)),
/// so every row view is a plain SwiftUI view that reads the `@Bindable
/// ChatViewModel` directly.
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
#endif
