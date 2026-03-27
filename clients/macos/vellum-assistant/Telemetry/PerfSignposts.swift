#if DEBUG
import Foundation
import os

// MARK: - Performance Signposts

/// Namespace for os_signpost markers used during Instruments profiling sessions.
/// Use the Points of Interest or Time Profiler template in Instruments to see
/// named coloured intervals for the hot paths identified in the scroll hang investigation.
///
/// Wrapped in `#if DEBUG` so release builds incur zero overhead from diagnostic
/// instrumentation. Use Instruments (Points of Interest template) in a Debug build
/// to measure body evaluation counts, hitch time, and graph update duration.
enum PerfSignposts {
    /// Shared log handle targeting the Points of Interest instrument lane.
    static let log = OSLog(
        subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
        category: .pointsOfInterest
    )

}
#endif
