import VellumAssistantShared

/// Discriminator that drives which detail panel the Home page renders in its
/// trailing split pane. Each case carries the originating `FeedItem` so the
/// panel can read item fields directly — no secondary lookup in `feedStore`
/// required.
///
/// `resolve(for:)` centralizes the dispatch rules that were previously
/// scattered across `HomePageView.openItem(_:)` and
/// `PanelCoordinator.homePanelView(…)`, so every call site agrees on which
/// items produce panels and which fall through to the conversation flow.
enum HomeDetailPanelKind: Equatable {
    case scheduled(FeedItem)
    case nudge(FeedItem)
    case emailDraft(FeedItem)
    case documentPreview(FeedItem)
    case permissionChat(FeedItem)
    case paymentAuth(FeedItem)
    case toolPermission(FeedItem)
    case updatesList(FeedItem)

    /// Resolves from the wire-contract `detailPanel` field. Returns `nil`
    /// when absent.
    static func resolve(for item: FeedItem) -> HomeDetailPanelKind? {
        guard let panel = item.detailPanel else {
            return nil
        }
        switch panel.kind {
        case .emailDraft: return .emailDraft(item)
        case .documentPreview: return .documentPreview(item)
        case .permissionChat: return .permissionChat(item)
        case .paymentAuth: return .paymentAuth(item)
        case .toolPermission: return .toolPermission(item)
        case .updatesList: return .updatesList(item)
        }
    }
}
