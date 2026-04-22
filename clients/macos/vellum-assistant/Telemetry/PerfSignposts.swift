import Foundation
import os
import SwiftUI

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

    /// Dedicated log category for `.transition(.move…)` and `.fixedSize()`
    /// boundary breadcrumbs used to triage Sentry main-thread hangs whose
    /// stack trace fingerprints an `_HStackLayout`/`_VStackLayout` sort
    /// inside `SizeFittingLayoutComputer.Engine.explicitAlignment` (see
    /// LUM-1116 / MACOS-66). The view name is emitted as a `.event`
    /// signpost on appear and disappear so the next hang event ships
    /// with a short breadcrumb trail identifying the exact transition
    /// or sizing boundary that was on-screen when the hang fired.
    ///
    /// Filter in Instruments' Points of Interest track (or spindump
    /// `os_log` section) by category `layout-hangs` to see only these
    /// breadcrumbs without the noise from other signposts.
    static let layoutHangs = OSLog(
        subsystem: Bundle.appBundleIdentifier,
        category: "layout-hangs"
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

// MARK: - Layout Hang Breadcrumb Modifier

extension View {
    /// Emit `os_signpost(.event …)` markers when this view appears and
    /// disappears, tagged with `name` on the `layout-hangs` log category.
    ///
    /// This is intentionally a zero-cost diagnostic — `.event` signposts are
    /// safe on the main thread, allocate nothing (because `name` must be a
    /// `StaticString`), and are elided from Sentry binary hang traces but
    /// survive in spindumps / Instruments / unified logging.
    ///
    /// Apply to `.transition(.move…)` call sites and `.fixedSize()` component
    /// boundaries so that when a Sentry hang trace lands with a stack like
    /// `SizeFittingLayoutComputer.Engine.explicitAlignment → _HStackLayout →
    /// _VStackLayout → …` (MACOS-66 / LUM-1116) we can read the recent
    /// signpost breadcrumb and identify which concrete view was on-screen —
    /// the stack alone doesn't name user-defined views.
    ///
    /// `name` is `StaticString` to guarantee no per-call allocation and no
    /// risk of touching non-trivial Swift runtime machinery on the main
    /// thread while the layout engine is already in a hot loop.
    func layoutHangSignpost(_ name: StaticString) -> some View {
        self
            .onAppear {
                os_signpost(.event, log: PerfSignposts.layoutHangs, name: name, "appear")
            }
            .onDisappear {
                os_signpost(.event, log: PerfSignposts.layoutHangs, name: name, "disappear")
            }
    }
}
