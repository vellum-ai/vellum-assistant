import VellumAssistantShared

/// Discriminator that drives which detail panel the Home page renders in its
/// trailing split pane. Each case carries the originating `FeedItem` so the
/// panel can read item fields directly — no secondary lookup in `feedStore`
/// required.
///
/// Only `toolPermission` and `generic` are reachable in production.
/// Unrecognized wire-contract kinds fall through to `.generic`.
enum HomeDetailPanelKind: Equatable {
    case toolPermission(FeedItem)
    case generic(FeedItem)

    /// Resolves from the wire-contract `detailPanel` field when present,
    /// otherwise falls back to a generic panel so every feed item opens a
    /// detail view on tap.
    static func resolve(for item: FeedItem) -> HomeDetailPanelKind {
        if let panel = item.detailPanel {
            switch panel.kind {
            case .toolPermission: return .toolPermission(item)
            case .emailDraft, .documentPreview, .permissionChat, .paymentAuth, .updatesList:
                return .generic(item)
            }
        }

        return .generic(item)
    }
}
