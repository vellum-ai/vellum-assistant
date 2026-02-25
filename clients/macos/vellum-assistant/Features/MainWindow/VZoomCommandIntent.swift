/// Explicit zoom command intents used by the menu bar to route
/// keyboard shortcuts to the correct zoom target.
///
/// Conversation zoom intents (`conversationZoomIn/Out/Reset`) are fired
/// by `Cmd +/-/0` and target the chat message text size. They are only
/// meaningful when a conversation is visible (thread or app-editing mode).
///
/// Window zoom intents (`windowZoomIn/Out/Reset`) are fired by
/// `Option+Cmd +/-/0` and always scale the entire window content.
enum VZoomCommandIntent {
    case conversationZoomIn
    case conversationZoomOut
    case conversationZoomReset
    case windowZoomIn
    case windowZoomOut
    case windowZoomReset
}
