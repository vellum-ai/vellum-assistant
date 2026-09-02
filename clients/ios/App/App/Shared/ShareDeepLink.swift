import Foundation

/// The `<scheme>://share/<id>` command that points the host app at one
/// share-inbox item.
///
/// The URL is a pointer, not the payload. Shared text and files live in the
/// App Group (`ShareInbox`); any app can open this scheme, but only this
/// app's share extension can write the inbox, so a forged id finds nothing
/// and is a no-op.
///
/// Lives in `Shared/` so the share extension can build the URL it opens
/// and the host parser stays a character-for-character match
/// (`SHARE_DEEP_LINK_HOST` in `clients/web/src/runtime/native-deep-link.ts`).
struct ShareDeepLink {
    /// Host segment shared with `SHARE_DEEP_LINK_HOST` on the web side.
    static let host = "share"

    let inboxId: String

    /// The command URL for the *running build*, or `nil` when the bundle
    /// declares no usable scheme or the id is not a safe path segment.
    func url(scheme: String? = BundleURLScheme.current) -> URL? {
        guard let scheme, ShareInbox.isSafeItemId(inboxId) else {
            return nil
        }
        var components = URLComponents()
        components.scheme = scheme
        components.host = Self.host
        components.path = "/" + inboxId
        return components.url
    }
}
