import Foundation

/// User-selectable LLM request log retention periods shown in the
/// Permissions & Privacy settings picker. Mirrors the server-side default
/// of 1 day and allows users to disable pruning entirely.
enum LlmLogRetentionOption: Int64, CaseIterable, Identifiable {
    case oneDay = 86_400_000          // 1 * 24 * 60 * 60 * 1000
    case sevenDays = 604_800_000      // 7 * 24 * 60 * 60 * 1000
    case thirtyDays = 2_592_000_000   // 30 * 24 * 60 * 60 * 1000
    case ninetyDays = 7_776_000_000   // 90 * 24 * 60 * 60 * 1000
    case never = 0

    var id: Int64 { rawValue }

    var label: String {
        switch self {
        case .oneDay: return "1 day"
        case .sevenDays: return "7 days"
        case .thirtyDays: return "30 days"
        case .ninetyDays: return "90 days"
        case .never: return "Never (keep forever)"
        }
    }

    /// Returns the closest option for an arbitrary millisecond value read from the daemon.
    /// Unknown / out-of-band values snap to the nearest known period; `0` is special-cased to `.never`.
    /// Ties (e.g. a value exactly halfway between two options) snap to the *larger* retention to avoid
    /// silently shortening a user's retention when the UI reconciles an out-of-band value.
    static func closest(toMs ms: Int64) -> LlmLogRetentionOption {
        if ms == 0 { return .never }
        let known = allCases.filter { $0 != .never }
        return known.min(by: { lhs, rhs in
            let lhsDist = abs(lhs.rawValue - ms)
            let rhsDist = abs(rhs.rawValue - ms)
            if lhsDist != rhsDist { return lhsDist < rhsDist }
            // Tie → prefer the larger (longer) retention.
            return lhs.rawValue > rhs.rawValue
        }) ?? .oneDay
    }
}
