import Foundation

/// Client-side placeholder card data for ``HomeNudgeDetailPanel``.
///
/// The feed wire format (`FeedItem`) doesn't yet carry rich card
/// content for `.nudge` items, so the initial UI surface ships with
/// fixed placeholder cards matching the Figma mock (4 "Issue Name"
/// cards, each with two generic Action buttons). This keeps the new
/// panel usable until the assistant follow-up wires real cards through.
enum HomeNudgeDetailPanelPlaceholders {
    /// Mirrors Figma node `3679:33260` — four cards, each with a
    /// primary + secondary action.
    static let sampleCards: [HomeNudgeDetailPanel.Card] = (1...4).map { index in
        HomeNudgeDetailPanel.Card(
            id: "placeholder-\(index)",
            title: "Issue Name",
            description: "This is an issue description written right here.",
            actions: [
                HomeNudgeDetailPanel.CardAction(
                    id: "placeholder-\(index)-primary",
                    label: "Action",
                    style: .primary
                ),
                HomeNudgeDetailPanel.CardAction(
                    id: "placeholder-\(index)-secondary",
                    label: "Action",
                    style: .secondary
                ),
            ]
        )
    }
}
