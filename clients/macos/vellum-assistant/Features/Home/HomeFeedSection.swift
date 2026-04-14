import SwiftUI
import VellumAssistantShared

/// Composition view that binds `HomeFeedStore` to the feed item views.
///
/// Responsibilities:
/// - Renders the context banner above the sorted list of feed items.
/// - Dispatches to `HomeFeedNudgeCard` for `.nudge` items and to
///   `HomeFeedListRow` for `.digest` / `.action` / `.thread` items.
/// - Translates user gestures (tap, action, dismiss) into async calls on
///   the store and forwards the resulting `conversationId` to the parent
///   so it can navigate into the newly-created conversation.
///
/// Empty state: when `store.items.isEmpty`, this view renders nothing —
/// not even the context banner — so the capabilities section below it
/// stays the dominant content. This matches the TDD's "empty feed state"
/// requirement: capabilities-only view with no feed chrome.
///
/// Sort order: items are displayed by `priority` descending, ties broken
/// by `createdAt` descending (newer within the same priority wins). The
/// store's `items` array is the raw feed as returned by the daemon; any
/// ordering not specified here is out of scope.
struct HomeFeedSection: View {
    @Bindable var store: HomeFeedStore

    /// Forwarded up to the parent when a feed action resolves to a
    /// conversation — the store returns the daemon-created conversation
    /// id, and the parent (PanelCoordinator) navigates into it.
    let onConversationOpened: (String) -> Void

    var body: some View {
        if !store.items.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                if let banner = store.contextBanner {
                    HomeContextBannerView(banner: banner)
                }
                LazyVStack(alignment: .leading, spacing: VSpacing.sm) {
                    ForEach(sortedItems, id: \.id) { item in
                        itemView(for: item)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func itemView(for item: FeedItem) -> some View {
        switch item.type {
        case .nudge:
            HomeFeedNudgeCard(
                item: item,
                onAction: { action in
                    Task { await triggerAction(itemId: item.id, actionId: action.id) }
                },
                onDismiss: {
                    Task { await store.dismiss(itemId: item.id) }
                }
            )
        case .digest, .action, .thread:
            HomeFeedListRow(
                item: item,
                onTap: {
                    // Synthetic "open" action — the daemon interprets any
                    // unknown action id as an open intent and seeds the
                    // new conversation with the first available action's
                    // prompt (or the item summary if no actions exist).
                    Task { await triggerAction(itemId: item.id, actionId: "open") }
                }
            )
        }
    }

    private func triggerAction(itemId: String, actionId: String) async {
        if let conversationId = await store.triggerAction(itemId: itemId, actionId: actionId) {
            onConversationOpened(conversationId)
        }
    }

    /// `priority` desc → `createdAt` desc. Newer items float up within
    /// the same priority bucket so the feed never buries a just-arrived
    /// platform digest under yesterday's leftover. Items with identical
    /// priority AND createdAt keep their original insertion order
    /// (Swift's `sorted(by:)` is stable), so two platform digests
    /// written in the same tick stay in writer order.
    private var sortedItems: [FeedItem] {
        store.items.sorted { a, b in
            if a.priority != b.priority {
                return a.priority > b.priority
            }
            return a.createdAt > b.createdAt
        }
    }
}
