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
    /// Unknown / out-of-band values snap to the closest known period; `0` is special-cased to `.never`.
    static func closest(toMs ms: Int64) -> LlmLogRetentionOption {
        if ms == 0 { return .never }
        let known = allCases.filter { $0 != .never }
        return known.min(by: { abs($0.rawValue - ms) < abs($1.rawValue - ms) }) ?? .oneDay
    }
}
