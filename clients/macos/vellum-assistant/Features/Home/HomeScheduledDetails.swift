import Foundation

/// Client-side render metadata for a scheduled (`.thread`) feed item.
/// The assistant doesn't yet surface these fields on `FeedItem`; this
/// struct lets the detail panel render with placeholder data until
/// the schedule source lands.
public struct HomeScheduledDetails: Hashable, Sendable {
    public let name: String
    public let syntax: String
    public let mode: String
    public let schedule: String
    public let enabled: Bool
    public let nextRun: Date
    public let nextRunTimeZone: TimeZone
    public let description: String

    public init(
        name: String,
        syntax: String,
        mode: String,
        schedule: String,
        enabled: Bool,
        nextRun: Date,
        nextRunTimeZone: TimeZone,
        description: String
    ) {
        self.name = name
        self.syntax = syntax
        self.mode = mode
        self.schedule = schedule
        self.enabled = enabled
        self.nextRun = nextRun
        self.nextRunTimeZone = nextRunTimeZone
        self.description = description
    }

    // MARK: - Display rows

    /// Ordered key/value pairs suitable for rendering in the detail panel.
    /// Order is fixed: Name, Syntax, Mode, Schedule, Enabled, Next Run.
    public func displayRows() -> [(key: String, value: String)] {
        // Construct a per-call formatter: `DateFormatter` is not thread-safe
        // when mutating `timeZone`, and the timezone is per-instance.
        let formatter = DateFormatter()
        formatter.locale = .autoupdatingCurrent
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        formatter.timeZone = nextRunTimeZone
        let nextRunString = formatter.string(from: nextRun)

        return [
            (key: "Name", value: name),
            (key: "Syntax", value: syntax),
            (key: "Mode", value: mode),
            (key: "Schedule", value: schedule),
            (key: "Enabled", value: enabled ? "true" : "false"),
            (key: "Next Run", value: nextRunString),
        ]
    }

    // MARK: - Placeholder

    /// Figma sample values used while the assistant schedule source is
    /// still under construction.
    public static let placeholder: HomeScheduledDetails = {
        let timeZone = TimeZone(identifier: "Europe/Ljubljana")!
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let nextRun = calendar.date(from: DateComponents(
            year: 2026,
            month: 4,
            day: 23,
            hour: 9,
            minute: 0
        )) ?? Date()

        return HomeScheduledDetails(
            name: "Morning check-in",
            syntax: "cron",
            mode: "notify",
            schedule: "Every day at 9:00 AM (Europe/Ljubljana)",
            enabled: true,
            nextRun: nextRun,
            nextRunTimeZone: timeZone,
            description: "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat."
        )
    }()
}
