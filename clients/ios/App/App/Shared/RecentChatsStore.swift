import Foundation

/// One entry of the recent-chats cache: just enough to render a picker row
/// and to build a `ThreadDeepLink` or share-inbox destination.
struct RecentChat: Codable, Equatable {
    let id: String
    let title: String
}

/// App Group cache of the user's recent conversations, written by
/// `RecentChatsPlugin` (the web layer syncs its sidebar list whenever it
/// changes) and read by `ChatEntityQuery` (the Shortcuts chat picker) and
/// the share extension's destination list.
///
/// A cache is the only workable data source for those pickers: the
/// conversation list lives in the SPA and its server, and both an App
/// Intents entity query and a share extension must answer from whatever
/// the process can reach, with no bridge, no web view, and no network.
/// Staleness is bounded by how recently the app was opened, and a stale
/// pick still resolves: the destination carries only the conversation id,
/// which the web layer resolves against live data.
///
/// The suite is the App Group rather than `UserDefaults.standard` because
/// the share extension is a different bundle with a different container.
/// `AppGroupID.current` is per environment, so the Dev / Staging /
/// production apps each keep their own cache. A nil group id falls back
/// to `UserDefaults.standard` so a misconfigured local build still feeds
/// the in-process Shortcuts picker.
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

    static func save(_ chats: [RecentChat], defaults: UserDefaults? = nil) {
        let suite = defaults ?? resolvedDefaults()
        let bounded = Array(chats.prefix(maxCount))
        guard let data = try? JSONEncoder().encode(bounded) else {
            return
        }
        suite.set(data, forKey: defaultsKey)
        migrateLegacyIfNeeded(afterWritingTo: suite)
    }

    /// The cached list, newest first (the order the web layer sent). Empty
    /// when the app has never synced, or when the stored blob fails to decode
    /// (treated as no cache rather than an error: the picker degrades to an
    /// empty list and the next sync rewrites it).
    static func load(defaults: UserDefaults? = nil) -> [RecentChat] {
        let suite = defaults ?? resolvedDefaults()
        if let chats = decode(from: suite), !chats.isEmpty {
            return chats
        }
        if suite !== UserDefaults.standard,
           let legacy = decode(from: .standard), !legacy.isEmpty {
            save(legacy, defaults: suite)
            return legacy
        }
        return decode(from: suite) ?? []
    }

    private static func resolvedDefaults() -> UserDefaults {
        AppGroupID.current.flatMap(UserDefaults.init(suiteName:)) ?? .standard
    }

    private static func decode(from defaults: UserDefaults) -> [RecentChat]? {
        guard let data = defaults.data(forKey: defaultsKey),
              let chats = try? JSONDecoder().decode([RecentChat].self, from: data)
        else {
            return nil
        }
        return chats
    }

    /// The pre-App-Group cache lived in `UserDefaults.standard`. Once the
    /// App Group suite holds a write, the leftover standard copy is dropped
    /// so the two cannot drift.
    private static func migrateLegacyIfNeeded(afterWritingTo suite: UserDefaults) {
        if suite !== UserDefaults.standard {
            UserDefaults.standard.removeObject(forKey: defaultsKey)
        }
    }
}
