import Foundation

/// The `<scheme>://conversations` command a Home Screen widget hands to the web
/// layer: bring up the list of conversations.
///
/// The destination the unread affordances point at. A count is a claim about
/// the inbox, so the tap that follows it has to land on the inbox rather than
/// on wherever the app was parked, which is what a widget carrying no URL of
/// its own falls through to.
///
/// A file of its own rather than a case on ``NewChatDeepLink``, matching how
/// every other link type in this directory is spelled: one type per host, so
/// the host constant sits next to the one parser it is shared with
/// (`CONVERSATIONS_DEEP_LINK_HOST` in
/// `clients/web/src/runtime/native-deep-link.ts`). It carries no parameters:
/// the host is the whole request, and the parser rejects a URL that carries a
/// path.
///
/// A thin identity over ``CommandDeepLink``, which owns everything this command
/// shares with ``CameraDeepLink`` and ``NewChatDeepLink``.
///
/// Lives in `Shared/` because `OpenConversationsIntent` is written in terms of
/// it and a widget button is code in the appex.
enum ConversationsDeepLink {
    /// Host segment shared with `CONVERSATIONS_DEEP_LINK_HOST` on the web side.
    private static let host = "conversations"

    /// Hand this command to the shell; see ``CommandDeepLink/route(host:)``.
    @MainActor
    static func route() {
        CommandDeepLink.route(host: host)
    }
}
