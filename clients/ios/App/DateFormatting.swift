#if canImport(UIKit)
import Foundation

enum DateFormatting {
    /// Returns a relative timestamp string (e.g. "2 min. ago", "3 hr. ago").
    static func relativeTimestamp(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    /// Returns a relative timestamp from a millisecond Unix epoch, or nil if <= 0.
    static func relativeTimestamp(fromMilliseconds ms: Int) -> String? {
        guard ms > 0 else { return nil }
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000.0)
        return relativeTimestamp(date)
    }
}
#endif
