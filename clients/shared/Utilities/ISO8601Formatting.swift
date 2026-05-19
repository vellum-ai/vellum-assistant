import Foundation

// MARK: - Date → String

extension Date {

    /// Formats to standard ISO 8601 (e.g. `"2026-03-26T14:30:00Z"`).
    ///
    /// Uses Apple's modern `Date.ISO8601FormatStyle` — a `Sendable` value type
    /// that avoids the heavyweight ICU calendar bootstrapping triggered by each
    /// `ISO8601DateFormatter()` initialisation.
    public var iso8601String: String {
        formatted(.iso8601)
    }

    /// Formats to ISO 8601 with fractional seconds
    /// (e.g. `"2026-03-26T14:30:00.123Z"`).
    public var iso8601WithFractionalSecondsString: String {
        formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }
}

// MARK: - String → Date

extension String {

    /// Parses an ISO 8601 string, trying fractional seconds first then plain.
    ///
    /// Handles both `"2026-03-26T14:30:00.123Z"` and `"2026-03-26T14:30:00Z"`.
    public var iso8601Date: Date? {
        if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true)
            .parse(self) {
            return date
        }
        return try? Date.ISO8601FormatStyle().parse(self)
    }
}

// MARK: - Relative time

extension Date {

    /// Compact relative-time string for inline metadata ("just now", "2h ago").
    ///
    /// `RelativeDateTimeFormatter` rounds anything under a minute to "0 sec.
    /// ago" / "in 0 sec." which reads as a glitch in a feed; collapse that
    /// window to "just now". `now` is injected so tests can pin a reference.
    public func relativeShortString(now: Date = Date()) -> String {
        let delta = abs(now.timeIntervalSince(self))
        if delta < 60 { return "just now" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: self, relativeTo: now)
    }
}
