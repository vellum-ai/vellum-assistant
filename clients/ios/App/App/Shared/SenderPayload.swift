import Foundation

/// The assistant identity a push carries, read from the top-level `sender`
/// object the platform attaches beside `aps`.
///
/// Shape: `{ "id", "name", "avatar_url", "avatar_hash" }`. `avatar_url` is the
/// first field the platform drops when a payload exceeds the APNs size limit,
/// so it is optional: the hash alone still hits a warm avatar cache. A push
/// without a complete `sender` (feature flag off, older platform) parses to
/// `nil` and the notification is delivered untouched.
struct SenderPayload: Equatable {
    let id: String
    let name: String
    let avatarURL: AvatarURL
    let avatarHash: String

    /// Where the avatar can be fetched from, or why it cannot be.
    ///
    /// An absent `avatar_url` is routine, and a warm cache serves the push
    /// anyway. A present one that `URL(string:)` cannot read is a platform
    /// fault. Keeping them apart is what lets one Console line say which.
    enum AvatarURL: Equatable {
        case url(URL)
        case absent
        case malformed
    }

    static func parse(userInfo: [AnyHashable: Any]) -> SenderPayload? {
        guard let sender = userInfo["sender"] as? [AnyHashable: Any],
              let id = nonEmptyString(sender["id"]),
              let name = nonEmptyString(sender["name"]),
              let avatarHash = nonEmptyString(sender["avatar_hash"])
        else {
            return nil
        }
        return SenderPayload(
            id: id,
            name: name,
            avatarURL: parseAvatarURL(sender["avatar_url"]),
            avatarHash: avatarHash
        )
    }

    private static func parseAvatarURL(_ value: Any?) -> AvatarURL {
        guard let text = nonEmptyString(value) else {
            return .absent
        }
        guard let url = URL(string: text) else {
            return .malformed
        }
        return .url(url)
    }

    private static func nonEmptyString(_ value: Any?) -> String? {
        guard let text = value as? String, !text.isEmpty else {
            return nil
        }
        return text
    }
}
