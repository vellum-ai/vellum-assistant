#if canImport(UIKit)
import SwiftUI
import UIKit
import VellumAssistantShared

/// Stable identifier for a row in the chat list. Used as the `ItemIdentifierType`
/// of `UICollectionViewDiffableDataSource` — only *structural* changes drive
/// diffs, while per-cell SwiftUI content updates through `@Observable` tracking
/// on `ChatViewModel`. Every case's associated value is a stable identity (a
/// message UUID, a subagent id string, or nothing for single-instance rows).
/// The queued-marker row is a singleton — its cell reads `queuedMessages.count`
/// directly from the view model so queue mutations update the displayed count
/// without invalidating the row's diffable identity.
enum ChatListItem: Hashable {
    case paginationHeader
    case queuedMarker
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
#endif
