import Foundation

/// A static action in the command palette (e.g., "New Conversation", "Settings").
struct CommandPaletteAction: Identifiable {
    let id: String
    let icon: String
    let label: String
    let shortcutHint: String?
    let action: () -> Void
}

/// A recent conversation shown in the command palette.
struct CommandPaletteRecentItem: Identifiable {
    let id: UUID
    let title: String
    let lastInteracted: Date
}

/// A search result item shown in the command palette.
enum CommandPaletteItem: Identifiable {
    case action(CommandPaletteAction)
    case recent(CommandPaletteRecentItem)

    var id: String {
        switch self {
        case .action(let a): return "action:\(a.id)"
        case .recent(let r): return "recent:\(r.id.uuidString)"
        }
    }
}
