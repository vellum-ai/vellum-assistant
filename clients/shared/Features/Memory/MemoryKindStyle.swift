import SwiftUI

/// Memory graph node types with display metadata (label, color, icon).
public enum MemoryKind: String, CaseIterable, Identifiable, Sendable {
    case episodic
    case semantic
    case procedural
    case emotional
    case prospective
    case behavioral
    case narrative
    case shared

    public var id: String { rawValue }

    /// Kinds that users may select when creating or editing memory items.
    /// Excludes system-managed kinds like `.procedural` (capabilities).
    public static var userCreatableKinds: [MemoryKind] {
        allCases.filter { $0 != .procedural }
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

    /// Display label for the kind.
    public var label: String {
        switch self {
        case .episodic:    return "Event"
        case .semantic:    return "Knowledge"
        case .procedural:  return "Skill"
        case .emotional:   return "Feeling"
        case .prospective: return "Plan"
        case .behavioral:  return "Pattern"
        case .narrative:   return "Story"
        case .shared:      return "Shared"
        }
    }

    /// Distinct fun-palette color for each kind.
    public var color: Color {
        switch self {
        case .episodic:    return VColor.funPink
        case .semantic:    return VColor.funTeal
        case .procedural:  return VColor.funRed
        case .emotional:   return VColor.funPurple
        case .prospective: return VColor.funGreen
        case .behavioral:  return VColor.funYellow
        case .narrative:   return VColor.funBlue
        case .shared:      return VColor.funCoral
        }
    }

    /// Lucide icon raw value matching `VIcon` cases.
    public var icon: String {
        switch self {
        case .episodic:    return VIcon.calendar.rawValue
        case .semantic:    return VIcon.brain.rawValue
        case .procedural:  return VIcon.zap.rawValue
        case .emotional:   return VIcon.heart.rawValue
        case .prospective: return VIcon.compass.rawValue
        case .behavioral:  return VIcon.refreshCw.rawValue
        case .narrative:   return VIcon.bookOpen.rawValue
        case .shared:      return VIcon.users.rawValue
        }
    }
}
