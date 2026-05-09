import Combine
import Foundation
import Observation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "BookmarkStore")

/// Local mirror of the daemon's bookmark list. Acts as the single source of
/// truth for hover-time "is this message bookmarked?" lookups
/// (``bookmarkedMessageIds``) and for any UI that lists bookmarks
/// (``bookmarks``). Mutations go through ``toggle(messageId:conversationId:)``,
/// which optimistically updates local state and reconciles with a full
/// ``reload()`` on error.
///
/// SSE events from the daemon (`bookmark.created` / `bookmark.deleted`,
/// emitted by `bookmark-routes.ts` via `assistantEventHub`) are forwarded by
/// the app-layer SSE subscriber as ``Notification/Name/bookmarkDidChange``
/// posts so a second window mutating the list keeps every connected client
/// in sync.
///
/// Mirrors the ``AssistantFeatureFlagStore`` Observable + Combine
/// `AnyCancellable` pattern. Holding the NotificationCenter subscription in
/// an `@ObservationIgnored` cancellable lets it tear down automatically and
/// avoids a manual `removeObserver` call from the `nonisolated` deinit
/// (which can't read the actor-isolated stored property under Swift 6
/// strict concurrency).
@MainActor
@Observable
public final class BookmarkStore {
    public private(set) var bookmarks: [BookmarkSummary] = []
    public private(set) var bookmarkedMessageIds: Set<String> = []

    @ObservationIgnored private let client: BookmarkClient
    @ObservationIgnored private var sseChangeCancellable: AnyCancellable?

    public init(
        client: BookmarkClient = BookmarkClient(),
        notificationCenter: NotificationCenter = .default
    ) {
        self.client = client
        sseChangeCancellable = notificationCenter.publisher(for: .bookmarkDidChange)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                Task { await self?.reload() }
            }
    }

    /// Fetch the authoritative bookmark list from the daemon and replace
    /// local state. Call once the gateway connection is established, and
    /// whenever a `bookmark.*` SSE event arrives from another window.
    public func reload() async {
        do {
            let fetched = try await client.listBookmarks()
            bookmarks = fetched
            bookmarkedMessageIds = Set(fetched.map(\.messageId))
        } catch {
            log.warning("Bookmark reload failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Toggle the bookmark for `messageId`. Optimistically mutates local
    /// state so the UI updates instantly; on failure, recovers by issuing a
    /// full ``reload()`` to drop back to the daemon's authoritative state.
    public func toggle(messageId: String, conversationId: String) async {
        if bookmarkedMessageIds.contains(messageId) {
            bookmarkedMessageIds.remove(messageId)
            bookmarks.removeAll { $0.messageId == messageId }
            do {
                try await client.deleteBookmarkByMessageId(messageId)
            } catch {
                log.warning("Bookmark delete failed: \(error.localizedDescription, privacy: .public)")
                await reload()
            }
        } else {
            // Optimistic flip so the icon updates in the same frame as the
            // click — symmetric with the delete branch above. The full row
            // (with daemon-assigned summary fields) is appended once
            // `createBookmark` returns.
            bookmarkedMessageIds.insert(messageId)
            do {
                let created = try await client.createBookmark(
                    messageId: messageId,
                    conversationId: conversationId
                )
                // Guard against a duplicate row if an SSE-driven reload
                // landed the same record first.
                if !bookmarks.contains(where: { $0.messageId == created.messageId }) {
                    bookmarks.insert(created, at: 0)
                }
            } catch {
                log.warning("Bookmark create failed: \(error.localizedDescription, privacy: .public)")
                bookmarkedMessageIds.remove(messageId)
                await reload()
            }
        }
    }
}

extension Notification.Name {
    /// Posted by the app-layer SSE subscriber when the daemon emits
    /// `bookmark.created` or `bookmark.deleted`. ``BookmarkStore`` listens for
    /// this and triggers a full reload so every window stays in sync with the
    /// daemon.
    public static let bookmarkDidChange = Notification.Name("bookmarkDidChange")
}
