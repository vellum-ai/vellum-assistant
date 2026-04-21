import Foundation
import VellumAssistantShared

/// Canonical day-bucket grouping for Home feed items.
///
/// Used by the Home page to split the feed into Today / Yesterday / Older
/// sections. The enum is Sendable so it can be passed across actor
/// boundaries alongside the `FeedItem` values it partitions.
///
/// See ``bucket(_:now:calendar:)`` for the grouping entry point.
enum HomeFeedTimeGroup: String, CaseIterable, Sendable {
    case today
    case yesterday
    case older

    /// User-facing section label for the group.
    var label: String {
        switch self {
        case .today:     return "Today"
        case .yesterday: return "Yesterday"
        case .older:     return "Older"
        }
    }

    /// Partitions `items` into `.today` / `.yesterday` / `.older` buckets
    /// based on each item's ``FeedItem/createdAt`` relative to `now`.
    ///
    /// - Parameters:
    ///   - items: Feed items to bucket. Input order is preserved within
    ///     each resulting group — the caller owns sort.
    ///   - now: Reference "current" moment. Defaults to `Date()`. Passed
    ///     explicitly by tests for determinism.
    ///   - calendar: Calendar used for the day comparisons. Defaults to
    ///     `.current`. Tests pass a calendar with a fixed `timeZone`.
    ///
    /// - Returns: Groups in canonical order `[.today, .yesterday, .older]`,
    ///   omitting any groups that would be empty.
    static func bucket(
        _ items: [FeedItem],
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [(group: HomeFeedTimeGroup, items: [FeedItem])] {
        guard !items.isEmpty else { return [] }

        var today: [FeedItem] = []
        var yesterday: [FeedItem] = []
        var older: [FeedItem] = []

        // `isDateInToday` / `isDateInYesterday` on a custom `Calendar`
        // (one with a fixed `timeZone`, for tests) don't consult `now` —
        // they compare against the calendar's current date. To get
        // deterministic bucketing with an injected `now`, fall back to
        // comparing calendar days directly.
        //
        // Derive yesterday from `now - 1 day` and normalize via
        // `startOfDay`, NOT by subtracting a day from the already-
        // normalized `todayDay`. In DST transitions that occur at
        // midnight (e.g. Africa/Cairo, Apr 25 2025), subtracting 1 day
        // from a midnight instant produces a non-midnight instant, so
        // `itemDay == yesterdayDay` fails and legitimate yesterday
        // items fall through to `.older`.
        let todayDay = calendar.startOfDay(for: now)
        let yesterdayInstant = calendar.date(byAdding: .day, value: -1, to: now) ?? now
        let yesterdayDay = calendar.startOfDay(for: yesterdayInstant)

        for item in items {
            let itemDay = calendar.startOfDay(for: item.createdAt)
            if itemDay == todayDay {
                today.append(item)
            } else if itemDay == yesterdayDay {
                yesterday.append(item)
            } else {
                older.append(item)
            }
        }

        var result: [(group: HomeFeedTimeGroup, items: [FeedItem])] = []
        if !today.isEmpty { result.append((.today, today)) }
        if !yesterday.isEmpty { result.append((.yesterday, yesterday)) }
        if !older.isEmpty { result.append((.older, older)) }
        return result
    }
}
