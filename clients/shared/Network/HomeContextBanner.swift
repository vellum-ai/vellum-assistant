import Foundation

/// Shared network contract for the Home page context banner.
///
/// The daemon returns this as part of the `GET /v1/home/feed` response
/// alongside the list of `FeedItem`s. It carries the small, one-line
/// "greeting · time-away · N new" strip that sits above the activity
/// feed so the user immediately knows what's changed since they last
/// checked in.
///
/// The greeting and time-away labels are fully composed server-side —
/// the macOS client does not do any date math or localization on these
/// fields, it just renders them verbatim. `newCount` is the integer
/// count of unseen feed items; the view hides the "N new" segment
/// entirely when it is zero so the banner never reads "0 new".
public struct ContextBanner: Codable, Sendable, Hashable {
    /// Pre-composed greeting line, e.g. "Good afternoon, Alex".
    public let greeting: String
    /// Pre-composed time-away label, e.g. "Away for 3 hours".
    public let timeAwayLabel: String
    /// Count of unseen feed items. Zero hides the "N new" segment.
    public let newCount: Int

    public init(greeting: String, timeAwayLabel: String, newCount: Int) {
        self.greeting = greeting
        self.timeAwayLabel = timeAwayLabel
        self.newCount = newCount
    }
}
