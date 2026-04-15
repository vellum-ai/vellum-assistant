import Foundation

/// User-selectable LLM request log retention periods shown in the
/// Permissions & Privacy settings picker. `null` (nil) means "keep forever",
/// `0` means "don't retain" (prune immediately), and positive values retain
/// for the specified number of milliseconds.
enum LlmLogRetentionOption: CaseIterable, Identifiable, Hashable {
    case dontRetain
    case oneHour
    case oneDay
    case sevenDays
    case thirtyDays
    case ninetyDays
    case keepForever

    var id: String {
        switch self {
        case .dontRetain: return "dontRetain"
        case .oneHour: return "oneHour"
        case .oneDay: return "oneDay"
        case .sevenDays: return "sevenDays"
        case .thirtyDays: return "thirtyDays"
        case .ninetyDays: return "ninetyDays"
        case .keepForever: return "keepForever"
        }
    }

    var retentionMs: Int64? {
        switch self {
        case .dontRetain: return 0
        case .oneHour: return 3_600_000
        case .oneDay: return 86_400_000
        case .sevenDays: return 604_800_000
        case .thirtyDays: return 2_592_000_000
        case .ninetyDays: return 7_776_000_000
        case .keepForever: return nil
        }
    }

    var label: String {
        switch self {
        case .dontRetain: return "Don't retain"
        case .oneHour: return "1 hour"
        case .oneDay: return "1 day"
        case .sevenDays: return "7 days"
        case .thirtyDays: return "30 days"
        case .ninetyDays: return "90 days"
        case .keepForever: return "Keep forever"
        }
    }

    /// Returns the closest option for an arbitrary millisecond value read from the daemon.
    /// `nil` maps to `.keepForever`, `0` maps to `.dontRetain`. Unknown / out-of-band positive
    /// values snap to the nearest known period; ties snap to the *larger* retention to avoid
    /// silently shortening a user's retention when the UI reconciles an out-of-band value.
    static func closest(toMs ms: Int64?) -> LlmLogRetentionOption {
        guard let ms = ms else { return .keepForever }
        if ms == 0 { return .dontRetain }
        let known: [LlmLogRetentionOption] = [.oneHour, .oneDay, .sevenDays, .thirtyDays, .ninetyDays]
        return known.min(by: { lhs, rhs in
            let lhsDist = abs(lhs.retentionMs! - ms)
            let rhsDist = abs(rhs.retentionMs! - ms)
            if lhsDist != rhsDist { return lhsDist < rhsDist }
            // Tie -> prefer the larger (longer) retention.
            return lhs.retentionMs! > rhs.retentionMs!
        }) ?? .oneHour
    }
}
