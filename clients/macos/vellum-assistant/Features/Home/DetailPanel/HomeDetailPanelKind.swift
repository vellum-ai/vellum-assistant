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

    /// Maps a `FeedItem` to its detail-panel kind, or returns `nil` when the
    /// item should keep the existing conversation-open flow.
    ///
    /// Checks `item.detailPanel` first (server-driven dispatch). Falls back
    /// to legacy heuristics when the field is absent:
    ///   - `.thread` + `.calendar` source → `.scheduled`
    ///   - `.nudge` (any source)          → `.nudge`
    ///   - everything else                → `nil`
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
        if item.type == .thread && item.source == .calendar {
            return .scheduled(item)
        }
        if item.type == .nudge {
            return .nudge(item)
        }
        return nil
    }
}
