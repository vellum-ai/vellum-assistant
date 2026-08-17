import AppIntents

/// A conversation as the Shortcuts app sees it: an id the deep link can carry
/// and a title the picker can render. Backed by `RecentChatsStore`, the cache
/// the web layer keeps in sync while the app runs.
struct ChatEntity: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Chat")
    static var defaultQuery = ChatEntityQuery()

    /// The daemon's conversation id, exactly as the web layer synced it. The
    /// intent puts it in the deep-link path verbatim; only the web layer can
    /// judge whether it still names a live conversation.
    var id: String
    var title: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)")
    }
}

/// Resolves `ChatEntity` values for the Shortcuts picker and for saved
/// shortcuts, from the local cache only. App Intents may run this with the
/// app launched in the background purely to configure an action, so there is
/// no bridge, no web view, and no network to ask; the cache is the whole
/// world here.
struct ChatEntityQuery: EntityStringQuery {
    /// Saved shortcuts must keep working even when their chat has aged out of
    /// the bounded cache, so unknown ids still resolve, to an entity with a
    /// generic title. The id is the only part the intent's deep link uses;
    /// the web layer resolves it against live data and owns the miss case.
    /// Ids reach this method only from entities this query previously vended,
    /// so fabricating a placeholder never invents a target the user did not
    /// pick.
    func entities(for identifiers: [ChatEntity.ID]) async throws -> [ChatEntity] {
        let titlesById = Dictionary(
            RecentChatsStore.load().map { ($0.id, $0.title) },
            uniquingKeysWith: { first, _ in first }
        )
        return identifiers.map { id in
            ChatEntity(id: id, title: titlesById[id] ?? "Chat")
        }
    }

    func entities(matching string: String) async throws -> [ChatEntity] {
        RecentChatsStore.load()
            .filter { $0.title.localizedCaseInsensitiveContains(string) }
            .map { ChatEntity(id: $0.id, title: $0.title) }
    }

    /// What the picker shows before the user types: the synced list in the
    /// order the web layer sent it (its sidebar recency order). Empty until
    /// the app has been opened once on this device, which is also the only
    /// state where there could be nothing meaningful to offer.
    func suggestedEntities() async throws -> [ChatEntity] {
        RecentChatsStore.load().map { ChatEntity(id: $0.id, title: $0.title) }
    }
}
