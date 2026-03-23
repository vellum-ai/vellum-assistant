import SwiftUI

/// Memory kinds with display metadata (label, color, icon).
public enum MemoryKind: String, CaseIterable, Identifiable, Sendable {
    case identity
    case preference
    case project
    case decision
    case constraint
    case event
    case journal
    case capability

    public var id: String { rawValue }

    /// Kinds that users may select when creating or editing memory items.
    /// Excludes system-managed kinds like `.capability` (Skill).
    public static var userCreatableKinds: [MemoryKind] {
        allCases.filter { $0 != .capability }
    }

    /// Kinds to show when editing an existing item.
    /// Includes `userCreatableKinds` plus the item's current kind if not already present.
    public static func editableKinds(current rawValue: String) -> [MemoryKind] {
        var kinds = userCreatableKinds
        if let current = MemoryKind(rawValue: rawValue), !kinds.contains(current) {
            kinds.append(current)
        }
        return kinds
    }

    /// Capitalised display label for the kind.
    public var label: String {
        switch self {
        case .capability: return "Skill"
        default: return rawValue.capitalized
        }
    }

    /// Distinct fun-palette color for each kind.
    public var color: Color {
        switch self {
        case .identity:   return VColor.funTeal
        case .preference: return VColor.funPurple
        case .project:    return VColor.funGreen
        case .decision:   return VColor.funYellow
        case .constraint: return VColor.funCoral
        case .event:      return VColor.funPink
        case .journal:    return VColor.funBlue
        case .capability: return VColor.funRed
        }
    }

    /// Lucide icon raw value matching `VIcon` cases.
    public var icon: String {
        switch self {
        case .identity:   return VIcon.user.rawValue
        case .preference: return VIcon.heart.rawValue
        case .project:    return VIcon.folder.rawValue
        case .decision:   return VIcon.gitBranch.rawValue
        case .constraint: return VIcon.shield.rawValue
        case .event:      return VIcon.calendar.rawValue
        case .journal:    return VIcon.bookOpen.rawValue
        case .capability: return VIcon.zap.rawValue
        }
    }
}
