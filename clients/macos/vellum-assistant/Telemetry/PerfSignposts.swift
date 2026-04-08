import Foundation
import os

// MARK: - Performance Signposts

/// Namespace for os_signpost markers used during Instruments profiling sessions.
/// Use the Points of Interest or Time Profiler template in Instruments to see
/// named coloured intervals for the hot paths identified in the scroll hang investigation.
enum PerfSignposts {
    /// Shared log handle targeting the Points of Interest instrument lane.
    static let log = OSLog(
        subsystem: Bundle.appBundleIdentifier,
        category: .pointsOfInterest
    )

    // MARK: - Chat Surface Signpost Helpers

    /// Marks the start of a SwiftUI body evaluation for a chat surface view.
    ///
    /// Use `endBodyEvaluation` with the returned `OSSignpostID` when the
    /// evaluation completes.
    static func beginBodyEvaluation(_ viewName: StaticString) -> OSSignpostID {
        let id = OSSignpostID(log: log)
        os_signpost(.begin, log: log, name: "bodyEvaluation", signpostID: id,
                    "%{public}s", String(describing: viewName))
        return id
    }

    /// Marks the end of a SwiftUI body evaluation interval.
    static func endBodyEvaluation(_ signpostID: OSSignpostID) {
        os_signpost(.end, log: log, name: "bodyEvaluation", signpostID: signpostID)
    }

    /// Marks the start of a transcript projection pass (deriving the
    /// visible message list from the underlying model).
    static func beginProjection() -> OSSignpostID {
        let id = OSSignpostID(log: log)
        os_signpost(.begin, log: log, name: "transcriptProjection", signpostID: id)
        return id
    }

    /// Marks the end of a transcript projection pass.
    static func endProjection(_ signpostID: OSSignpostID) {
        os_signpost(.end, log: log, name: "transcriptProjection", signpostID: signpostID)
    }

    /// Marks the start of a popup refresh cycle (slash command or emoji picker).
    static func beginPopupRefresh(_ popupKind: StaticString) -> OSSignpostID {
        let id = OSSignpostID(log: log)
        os_signpost(.begin, log: log, name: "popupRefresh", signpostID: id,
                    "%{public}s", String(describing: popupKind))
        return id
    }

    /// Marks the end of a popup refresh cycle.
    static func endPopupRefresh(_ signpostID: OSSignpostID) {
        os_signpost(.end, log: log, name: "popupRefresh", signpostID: signpostID)
    }

    /// Emits a single-point signpost for a scroll intent event.
    static func markScrollIntent(_ intent: StaticString) {
        os_signpost(.event, log: log, name: "scrollIntent",
                    "%{public}s", String(describing: intent))
    }

    /// Marks the start of a first-responder sync cycle (AppKit text bridge
    /// coordinating focus state with SwiftUI).
    static func beginFirstResponderSync() -> OSSignpostID {
        let id = OSSignpostID(log: log)
        os_signpost(.begin, log: log, name: "firstResponderSync", signpostID: id)
        return id
    }

    /// Marks the end of a first-responder sync cycle.
    static func endFirstResponderSync(_ signpostID: OSSignpostID) {
        os_signpost(.end, log: log, name: "firstResponderSync", signpostID: signpostID)
    }
}
