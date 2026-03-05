import os

// MARK: - Performance Signposts

/// Namespace for os_signpost markers used during Instruments profiling sessions.
/// Use the Points of Interest or Time Profiler template in Instruments to see
/// named coloured intervals for the hot paths identified in the scroll hang investigation.
enum PerfSignposts {
    /// Shared log handle targeting the Points of Interest instrument lane.
    static let log = OSLog(
        subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
        category: .pointsOfInterest
    )

    // MARK: - Helpers

    /// Wraps `ChatMarkdownParser.parseMarkdownSegments()`.
    @inlinable static func beginMarkdownParse() {
        os_signpost(.begin, log: log, name: "markdownParse")
    }

    @inlinable static func endMarkdownParse() {
        os_signpost(.end, log: log, name: "markdownParse")
    }

    /// Wraps `MarkdownSegmentView.computeGroupedSegments()`.
    @inlinable static func beginMarkdownGroupSegments() {
        os_signpost(.begin, log: log, name: "markdownGroupSegments")
    }

    @inlinable static func endMarkdownGroupSegments() {
        os_signpost(.end, log: log, name: "markdownGroupSegments")
    }

    /// Wraps `MarkdownSegmentView.buildCombinedAttributedString(from:)`.
    @inlinable static func beginAttributedStringBuild() {
        os_signpost(.begin, log: log, name: "attributedStringBuild")
    }

    @inlinable static func endAttributedStringBuild() {
        os_signpost(.end, log: log, name: "attributedStringBuild")
    }

    /// Wraps the `onPreferenceChange` handlers in `MessageListView`.
    @inlinable static func beginAnchorPreferenceChange() {
        os_signpost(.begin, log: log, name: "anchorPreferenceChange")
    }

    @inlinable static func endAnchorPreferenceChange() {
        os_signpost(.end, log: log, name: "anchorPreferenceChange")
    }
}
