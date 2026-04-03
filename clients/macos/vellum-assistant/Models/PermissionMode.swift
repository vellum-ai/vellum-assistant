import Foundation
import VellumAssistantShared

/// Local convenience wrapper around the daemon's two-axis permission mode.
///
/// Matches the shape returned by `GET /v1/permission-mode` and broadcast
/// via `permission_mode_update` SSE events. The canonical Codable type is
/// `PermissionModeUpdateMessage` in `VellumAssistantShared`; this file
/// provides domain-specific helpers for the macOS app.
///
/// Axes:
/// - `askBeforeActing` — when true the assistant checks in before taking
///   high-stakes actions.
/// - `hostAccess` — when true the assistant can execute commands on the
///   host machine without prompting.
enum PermissionModeDefaults {
    /// Default permission mode: ask before acting, no host access.
    static let askBeforeActing: Bool = true
    static let hostAccess: Bool = false
}
