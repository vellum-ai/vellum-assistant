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
