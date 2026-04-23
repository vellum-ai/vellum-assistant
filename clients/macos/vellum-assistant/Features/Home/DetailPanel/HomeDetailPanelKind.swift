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

    /// Resolves from the wire-contract `detailPanel` field when present,
    /// otherwise falls back to legacy type+source heuristics so
    /// scheduled/nudge panels remain reachable for items that don't yet
    /// carry a `detailPanel`.
    static func resolve(for item: FeedItem) -> HomeDetailPanelKind? {
        if let panel = item.detailPanel {
            switch panel.kind {
            case .emailDraft: return .emailDraft(item)
            case .documentPreview: return .documentPreview(item)
            case .permissionChat: return .permissionChat(item)
            case .paymentAuth: return .paymentAuth(item)
            case .toolPermission: return .toolPermission(item)
            case .updatesList: return .updatesList(item)
            }
        }

        // Legacy heuristic fallbacks — kept until the daemon populates
        // `detailPanel` for every item type.
        switch item.type {
        case .thread where item.source == .calendar:
            return .scheduled(item)
        case .nudge:
            return .nudge(item)
        default:
            return nil
        }
    }
}
