/// Buffers a deep-link / Siri Shortcut message so it survives cold launch
/// (where no `ChatViewModel` may exist yet) and is consumed only by the
/// active conversation's view model.
public enum DeepLinkManager {
    /// The pending message text. Set by `SendMessageIntent` or the URL handler;
    /// consumed (and cleared) by the active `ChatViewModel` via
    /// `consumeDeepLinkIfNeeded()`.
    @MainActor public static var pendingMessage: String?
}
