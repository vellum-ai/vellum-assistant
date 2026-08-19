import Foundation

/// One entry of the recent-chats cache: just enough to render a Shortcuts
/// picker row and to build a `ThreadDeepLink` when the intent runs.
struct RecentChat: Codable, Equatable {
    let id: String
    let title: String
}

/// UserDefaults-backed cache of the user's recent conversations, written by
/// `RecentChatsPlugin` (the web layer syncs its sidebar list whenever it
/// changes) and read by `ChatEntityQuery` (the Shortcuts chat picker).
///
/// A cache is the only workable data source for the picker: the conversation
/// list lives in the SPA and its server, and an App Intents entity query must
/// answer synchronously-ish from whatever the process can reach, including
/// when Shortcuts launches the app in the background just to configure an
/// action. Staleness is bounded by how recently the app was opened, and a
/// stale pick still resolves: the deep link carries only the conversation id,
/// which the web layer resolves against live data.
///
/// `UserDefaults.standard` is per bundle id, so the Dev / Staging / production
/// apps each keep their own cache, matching their separate origins.
///
/// ## Cache boundary
///
/// There is deliberately no invalidation on sign-out or a self-hosted-origin
/// switch: the cache holds only ids and titles (no message content), it is
/// device-local to the same OS user, and the next confirmed list sync from
/// whoever is signed in replaces it wholesale. Until that sync, the picker
/// may show the previous account's or origin's titles; picking one produces
/// an id the web layer cannot confirm against its conversation list, so the
/// send request demotes to a pre-filled composer on an empty conversation
/// route (`useDeepLinkThreadSend`) and nothing is sent anywhere.
enum RecentChatsStore {
    static let defaultsKey = "recentChats"

    /// Defensive ceiling on what one `save` accepts. The web side already
    /// sends a bounded list; this keeps a misbehaving caller from growing the
    /// defaults plist without limit.
    private static let maxCount = 100

    static func save(_ chats: [RecentChat]) {
        let bounded = Array(chats.prefix(maxCount))
        guard let data = try? JSONEncoder().encode(bounded) else {
            return
        }
        UserDefaults.standard.set(data, forKey: defaultsKey)
    }

    /// The cached list, newest first (the order the web layer sent). Empty
    /// when the app has never synced, or when the stored blob fails to decode
    /// (treated as no cache rather than an error: the picker degrades to an
    /// empty list and the next sync rewrites it).
    static func load() -> [RecentChat] {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey),
              let chats = try? JSONDecoder().decode([RecentChat].self, from: data)
        else {
            return []
        }
        return chats
    }
}
