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

// MARK: - Server Search Results

/// A conversation result from the global search API.
struct SearchResultConversation: Identifiable, Decodable {
    let id: String
    let title: String?
    let updatedAt: Double
    let excerpt: String
    let matchCount: Int
}

/// A schedule result from the global search API.
struct SearchResultSchedule: Identifiable, Decodable {
    let id: String
    let name: String
    let expression: String
    let message: String
    let enabled: Bool
    let nextRunAt: Double?
}

/// A contact result from the global search API.
struct SearchResultContact: Identifiable, Decodable {
    let id: String
    let displayName: String
    let notes: String?
    let lastInteraction: Double?
}

/// The grouped results from the global search API.
struct GlobalSearchResults: Decodable {
    let conversations: [SearchResultConversation]
    let schedules: [SearchResultSchedule]
    let contacts: [SearchResultContact]

    static let empty = GlobalSearchResults(
        conversations: [], schedules: [], contacts: []
    )
}

struct GlobalSearchResponse: Decodable {
    let query: String
    let results: GlobalSearchResults
}

// MARK: - Unified Item Enum

/// A search result item shown in the command palette.
enum CommandPaletteItem: Identifiable {
    case action(CommandPaletteAction)
    case recent(CommandPaletteRecentItem)
    case conversation(SearchResultConversation)
    case schedule(SearchResultSchedule)
    case contact(SearchResultContact)

    var id: String {
        switch self {
        case .action(let a): return "action:\(a.id)"
        case .recent(let r): return "recent:\(r.id.uuidString)"
        case .conversation(let c): return "conv:\(c.id)"
        case .schedule(let s): return "sched:\(s.id)"
        case .contact(let c): return "contact:\(c.id)"
        }
    }
}
