import Foundation

/// The `<scheme>://new-chat` command a Home Screen widget hands to the web
/// layer: open a fresh draft conversation with the composer focused.
///
/// A file of its own rather than a case on ``CameraDeepLink``, matching how
/// every other link type in this directory is spelled: one type per host, so
/// the host constant sits next to the one parser it is shared with
/// (`NEW_CHAT_DEEP_LINK_HOST` in
/// `clients/web/src/runtime/native-deep-link.ts`). It carries no parameters:
/// the host is the whole request, and the parser rejects a URL that carries a
/// path.
///
/// A thin identity over ``CommandDeepLink``, which owns everything this command
/// shares with ``CameraDeepLink``.
///
/// Lives in `Shared/` because `OpenNewChatIntent` is written in terms of it
/// and a widget button is code in the appex.
enum NewChatDeepLink {
    /// Host segment shared with `NEW_CHAT_DEEP_LINK_HOST` on the web side.
    private static let host = "new-chat"

    /// Hand this command to the shell; see ``CommandDeepLink/route(host:)``.
    @MainActor
    static func route() {
        CommandDeepLink.route(host: host)
    }
}
