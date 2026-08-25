import Foundation

/// One conversation of the widget snapshot: just enough to render a Home
/// Screen row and to deep-link into the conversation it names.
///
/// `subtitle` is the conversation's group name, absent when it belongs to no
/// group. Ordering is the producer's, so the rows carry no timestamp of their
/// own: nothing here renders one.
struct WidgetSnapshotConversation: Codable, Equatable {
    let id: String
    let title: String
    let subtitle: String?
    let hasUnseen: Bool
    let isProcessing: Bool
}

/// The assistant's avatar, so a widget can draw the user's own colors and face
/// instead of a fixed brand palette.
///
/// The image travels as bytes because the extension has no network stack and
/// no auth of its own, the same reason the Live Activity's avatar does.
///
/// `kind` is the web side's `AvatarRender` vocabulary (`character`, `image`,
/// `none`) rather than a native enum: an unknown value has to read as "no
/// avatar I can draw", which is a fallback every widget already has, and not as
/// a decode failure that would cost the counts and rows too. `accentHex` is
/// canonical (see ``canonicalCSSHex(_:)``) or nil, and is nil for a custom
/// image by design, since there is no single color to match.
struct WidgetSnapshotAvatar: Codable, Equatable {
    let kind: String
    let accentHex: String?
    let imageData: Data?
}

/// Everything the Home Screen knows about the signed-in user's conversations:
/// two counts and the few most recent threads, as of `generatedAt`, plus the
/// avatar the widgets theme themselves from.
struct WidgetSnapshot: Codable, Equatable {
    /// Version of the stored shape. `WidgetSnapshotStore` refuses a blob
    /// carrying any other value, so a field this build cannot make sense of
    /// reads as no snapshot rather than as a half-decoded one.
    static let currentSchemaVersion = 2

    let schemaVersion: Int
    let generatedAt: Date
    let unreadCount: Int
    let inProgressCount: Int
    let conversations: [WidgetSnapshotConversation]
    /// Optional even though the producer always sends it: a dict the shell
    /// cannot make sense of should cost the widgets their theming, never their
    /// counts and rows.
    let avatar: WidgetSnapshotAvatar?
}

/// The `kind` string each Vellum widget registers under, and the identifier
/// `WidgetCenter.reloadTimelines(ofKind:)` names to refresh it. Both sides
/// read them from here so a rename cannot desynchronize a widget from the
/// reload that is supposed to reach it.
enum VellumWidgetKind {
    static let catchUp = "VellumCatchUp"
    static let status = "VellumStatus"
    static let quickActions = "VellumQuickActions"

    /// All of them, for a writer to reload: every kind renders from the one
    /// snapshot, so a write invalidates all three.
    static let all = [catchUp, status, quickActions]
}

/// App Group UserDefaults cache of the widget snapshot, written by
/// `WidgetSnapshotPlugin` whenever the web layer's conversation summary
/// changes, and readable from the VoiceActivity extension.
///
/// A cache is the only workable data source there: the conversation list lives
/// in the SPA and its server, and the extension process has no network stack,
/// no auth, and no way to run the SPA. Staleness is bounded by how recently
/// the app was open, and the snapshot carries only display data (ids, titles,
/// group names, counts, timestamps), never a credential.
///
/// The suite is the App Group rather than `UserDefaults.standard` because the
/// appex is a different bundle with a different container. `AppGroupID.current`
/// is per environment, so the Dev / Staging / production apps each keep their
/// own snapshot, matching their separate origins. A nil group id, or an
/// entitlement the running build cannot satisfy, makes every method here a
/// silent no-op rather than a failure: reading nothing is a degradation, and
/// neither the app nor the appex has an error path worth taking on a surface
/// the user never asked to interact with.
///
/// ## Cache boundary
///
/// Unlike `RecentChatsStore`, which deliberately holds its cache across
/// sign-out, this one is clearable and `WidgetSnapshotPlugin` exposes `clear`
/// for the web layer to call. The difference is where the data is read: a
/// Shortcuts picker opens only when someone drives the app, while a Home
/// Screen widget renders whenever the screen lights up, including on a locked
/// device. Conversation titles belonging to an account that is no longer
/// signed in must not outlive the session on a surface like that.
enum WidgetSnapshotStore {
    static let defaultsKey = "widgetSnapshot"

    /// Key holding the origin the stored snapshot belongs to. See
    /// ``appliedOrigin()``.
    static let appliedOriginKey = "appliedOrigin"

    private static var defaults: UserDefaults? {
        AppGroupID.current.flatMap(UserDefaults.init(suiteName:))
    }

    /// One date strategy for both directions, so the blob a writer produces is
    /// the blob a reader can decode.
    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    static func save(_ snapshot: WidgetSnapshot) {
        guard let defaults, let data = try? encoder.encode(snapshot) else {
            return
        }
        defaults.set(data, forKey: defaultsKey)
    }

    /// The stored snapshot, or `nil` when the app has never synced, when the
    /// blob fails to decode, or when it was written against a different
    /// schema version. All three read as no snapshot rather than as an error:
    /// the reader falls back to its empty state and the next sync rewrites
    /// the blob.
    static func load() -> WidgetSnapshot? {
        guard let data = defaults?.data(forKey: defaultsKey),
              let snapshot = try? decoder.decode(WidgetSnapshot.self, from: data),
              snapshot.schemaVersion == WidgetSnapshot.currentSchemaVersion
        else {
            return nil
        }
        return snapshot
    }

    /// Drop the snapshot. The applied-origin mirror below deliberately stays:
    /// it records which origin this container belongs to, which an emptied
    /// container still does, and removing it would disarm the comparison the
    /// next launch makes.
    static func clear() {
        defaults?.removeObject(forKey: defaultsKey)
    }

    /// The origin the stored snapshot belongs to, or `nil` when none has been
    /// recorded yet (a fresh install, or one predating this key).
    ///
    /// The mirror lives here, in the App Group, because the staleness it guards
    /// is the one no in-memory value can see: the active origin can change
    /// while the app is not running, and this container is what survives that.
    /// `nil` therefore means "not recorded", never "no origin"; the origin
    /// string itself carries the case where the shell serves its baked default.
    /// `WidgetSnapshotPlugin.recordAppliedOrigin` is the only reader and writer
    /// and defines what each value means.
    static func appliedOrigin() -> String? {
        return defaults?.string(forKey: appliedOriginKey)
    }

    static func setAppliedOrigin(_ origin: String) {
        defaults?.set(origin, forKey: appliedOriginKey)
    }
}
