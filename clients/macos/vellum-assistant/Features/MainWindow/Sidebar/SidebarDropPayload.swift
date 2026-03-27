import Foundation

/// Shared payload parser for sidebar drag-and-drop operations.
/// Distinguishes between conversation drops (UUID string) and group drops ("group:xyz" prefix).
///
/// M4: conversations are the only drag source — callers use `.conversation(uuid)`.
/// M5: adds group dragging with a "group:" prefix via `.group(id)`.
enum SidebarDropPayload {
    case conversation(UUID)
    case group(String)

    /// Parse a drop payload from a raw string.
    /// - "group:xyz" -> `.group("xyz")`
    /// - Valid UUID string -> `.conversation(uuid)`
    /// - Otherwise -> nil
    static func parse(from string: String) -> SidebarDropPayload? {
        if string.hasPrefix("group:") {
            let groupId = String(string.dropFirst("group:".count))
            return .group(groupId)
        } else if let uuid = UUID(uuidString: string) {
            return .conversation(uuid)
        }
        return nil
    }
}
