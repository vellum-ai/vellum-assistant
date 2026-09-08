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
    let avatarURL: URL?
    let avatarHash: String

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
            avatarURL: nonEmptyString(sender["avatar_url"]).flatMap { URL(string: $0) },
            avatarHash: avatarHash
        )
    }

    /// Thread the rewritten notification belongs to, read from the same
    /// `deep_link.conversationId` a tap routes through
    /// (`extractPushConversationId` in `clients/web/src/runtime/push-registration.ts`).
    ///
    /// The sender id is the fallback so notifications from one assistant still
    /// group together when the platform dropped the deep link to fit the
    /// payload budget.
    static func conversationIdentifier(
        userInfo: [AnyHashable: Any],
        senderId: String
    ) -> String {
        guard let deepLink = userInfo["deep_link"] as? [AnyHashable: Any],
              let conversationId = nonEmptyString(deepLink["conversationId"])
        else {
            return senderId
        }
        return conversationId
    }

    private static func nonEmptyString(_ value: Any?) -> String? {
        guard let text = value as? String, !text.isEmpty else {
            return nil
        }
        return text
    }
}
