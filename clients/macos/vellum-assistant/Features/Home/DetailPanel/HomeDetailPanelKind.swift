import VellumAssistantShared

/// Discriminator that drives which detail panel the Home page renders in its
/// trailing split pane. Each case carries the originating `FeedItem` so the
/// panel can read item fields directly — no secondary lookup in `feedStore`
/// required.
///
/// `resolve(for:)` mirrors the cases of the wire-contract
/// ``FeedItemDetailPanelKind`` 1:1 plus a `.generic` fallback for items
/// that don't carry an explicit panel descriptor — every tap opens some
/// kind of detail view.
enum HomeDetailPanelKind: Equatable {
    case emailDraft(FeedItem)
    case documentPreview(FeedItem)
    case permissionChat(FeedItem)
    case paymentAuth(FeedItem)
    case toolPermission(FeedItem)
    case updatesList(FeedItem)
    case generic(FeedItem)

    /// Resolves from the wire-contract `detailPanel` field when present,
    /// otherwise falls back to a generic panel so every feed item opens a
    /// detail view on tap.
    static func resolve(for item: FeedItem) -> HomeDetailPanelKind {
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

        return .generic(item)
    }
}
