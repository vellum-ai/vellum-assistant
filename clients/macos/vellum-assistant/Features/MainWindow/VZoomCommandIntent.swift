/// Explicit zoom command intents used by the menu bar to route
/// keyboard shortcuts to the correct zoom target.
///
/// Window zoom intents (`windowZoomIn/Out/Reset`) are fired by
/// `Cmd +/-/0` and scale the entire window content.
enum VZoomCommandIntent {
    case windowZoomIn
    case windowZoomOut
    case windowZoomReset
}
