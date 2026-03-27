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

}
