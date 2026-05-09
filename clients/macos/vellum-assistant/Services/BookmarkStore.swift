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
/// the SSE router as ``Notification/Name/bookmarkDidChange`` posts so a
/// second window mutating the list keeps every connected client in sync.
///
/// Mirrors the ``AssistantFeatureFlagStore`` Observable + NotificationCenter
/// pattern so SwiftUI views are only invalidated when the specific properties
/// they read change.
@MainActor
@Observable
public final class BookmarkStore {
    public private(set) var bookmarks: [BookmarkSummary] = []
    public private(set) var bookmarkedMessageIds: Set<String> = []
    public private(set) var isLoading: Bool = false

    @ObservationIgnored private let client: BookmarkClientProtocol
    @ObservationIgnored private var sseObserver: NSObjectProtocol?

    public init(client: BookmarkClientProtocol = BookmarkClient()) {
        self.client = client
        subscribeToSSE()
    }

    deinit {
        if let sseObserver {
            NotificationCenter.default.removeObserver(sseObserver)
        }
    }

    /// Fetch the authoritative bookmark list from the daemon and replace
    /// local state. Call once at bootstrap, and whenever a `bookmark.*` SSE
    /// event arrives from another window.
    public func reload() async {
        isLoading = true
        defer { isLoading = false }
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
                _ = try await client.deleteBookmarkByMessageId(messageId)
            } catch {
                log.warning("Bookmark delete failed: \(error.localizedDescription, privacy: .public)")
                await reload()
            }
        } else {
            do {
                let created = try await client.createBookmark(
                    messageId: messageId,
                    conversationId: conversationId
                )
                // Idempotent insert: an SSE-driven reload may have landed the
                // same row first, so guard against the duplicate.
                if !bookmarkedMessageIds.contains(created.messageId) {
                    bookmarkedMessageIds.insert(created.messageId)
                    bookmarks.insert(created, at: 0)
                }
            } catch {
                log.warning("Bookmark create failed: \(error.localizedDescription, privacy: .public)")
                await reload()
            }
        }
    }

    private func subscribeToSSE() {
        sseObserver = NotificationCenter.default.addObserver(
            forName: .bookmarkDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { await self?.reload() }
        }
    }
}

extension Notification.Name {
    /// Posted by the SSE router when the daemon emits `bookmark.created` or
    /// `bookmark.deleted`. ``BookmarkStore`` listens for this and triggers a
    /// full reload so every window stays in sync with the daemon.
    public static let bookmarkDidChange = Notification.Name("bookmarkDidChange")
}
