import AppKit
import SwiftUI
import VellumAssistantShared

/// Developer HUD that displays live scroll metrics in the top-right of the
/// conversation. Hidden unless the `scroll-debug-overlay` macOS feature flag
/// is enabled from Settings → Developer.
///
/// Isolated observation boundary: reading `scrollState.debugMetricsVersion`
/// in the hud body registers this view for invalidation on every metric
/// tick without invalidating `MessageListView.body`. All other geometry
/// fields on `MessageListScrollState` are `@ObservationIgnored`, so the
/// version counter is what drives re-renders.
struct ScrollDebugOverlayView: View {
    let scrollState: MessageListScrollState

    /// Seeded from the flag manager on first appear, then kept in sync via
    /// `.assistantFeatureFlagDidChange`. Starting at `false` and deferring the
    /// lookup to `.onAppear` avoids paying the flag-manager lock cost on every
    /// re-render of the parent `MessageListView`.
    @State private var isEnabled: Bool = false
    @State private var recorder = ScrollDebugRecorder()

    var body: some View {
        Group {
            if isEnabled {
                hud
            }
        }
        .onAppear {
            isEnabled = MacOSClientFeatureFlagManager.shared.isEnabled("scroll-debug-overlay")
        }
        .onReceive(NotificationCenter.default.publisher(for: .assistantFeatureFlagDidChange)) { notification in
            guard let key = notification.userInfo?["key"] as? String, key == "scroll-debug-overlay" else { return }
            isEnabled = MacOSClientFeatureFlagManager.shared.isEnabled("scroll-debug-overlay")
        }
    }

    private var hud: some View {
        // `TimelineView(.animation)` drives a redraw every frame (display link
        // cadence) while the HUD is mounted, so time-derived readings like
        // updates/s, anchors/s, and the idle-snapped velocity stay current
        // even when no scroll events are arriving. This is a dev-only debug
        // panel, so the per-frame evaluation cost is deliberate.
        TimelineView(.animation) { context in
            hudContent(now: context.date)
        }
    }

    private func hudContent(now: Date) -> some View {
        // Reading the observed version counter still registers an
        // invalidation dependency so metric writes that happen faster
        // than the display cadence also trigger redraws.
        _ = scrollState.debugMetricsVersion

        let metrics = scrollState.debugMetrics
        let pinnedEpsilon: CGFloat = 8
        let pinnedLatest = scrollState.lastContentOffsetY.magnitude < pinnedEpsilon
        let updatesPerSec = metrics.updatesPerSecond(at: now)
        let velocity = metrics.displayedVelocity(at: now)
        let anchorsPerSec = metrics.anchorShiftsPerSecond(at: now)

        let lastAnchor = metrics.lastAnchorDecision
        let anchorAgeMs: Int? = lastAnchor.map { Int(max(0, now.timeIntervalSince($0.at)) * 1000) }
        let anchorOutcome: String = lastAnchor.map(Self.outcomeLabel) ?? ""
        let anchorDelta: CGFloat = {
            guard case .applied(let d) = lastAnchor?.outcome else { return 0 }
            return d
        }()

        if recorder.isRecording {
            recorder.capture(ScrollDebugRecorder.Frame(
                timestamp: now,
                offsetY: scrollState.lastContentOffsetY,
                contentH: scrollState.scrollContentHeight,
                containerH: scrollState.scrollContainerHeight,
                viewportH: scrollState.viewportHeight,
                distBottom: scrollState.distanceFromBottom,
                distTop: scrollState.distanceFromTop,
                pinnedLatest: pinnedLatest,
                liveScrolling: metrics.isLiveScrolling,
                paginating: scrollState.isPaginationInFlight,
                paginationInRange: scrollState.wasPaginationTriggerInRange,
                ctaVisible: scrollState.showScrollToLatest,
                updatesPerSecond: updatesPerSec,
                velocity: velocity,
                lastDeltaY: metrics.lastDeltaY,
                lastContentHDelta: metrics.lastContentHDelta,
                anchorsPerSecond: anchorsPerSec,
                anchorTotal: metrics.anchorShiftTotal,
                anchorOutcome: anchorOutcome,
                anchorDelta: anchorDelta,
                anchorContentHDelta: lastAnchor?.contentHDelta ?? 0,
                anchorPreOffsetY: lastAnchor?.preOffsetY ?? 0,
                anchorPostOffsetY: lastAnchor?.postOffsetY ?? 0,
                anchorAgeMs: anchorAgeMs ?? -1,
                conversationId: scrollState.currentConversationId
            ))
        }

        return VStack(alignment: .leading, spacing: 1) {
            row("offsetY", pt(scrollState.lastContentOffsetY))
            row("contentH", pt(scrollState.scrollContentHeight))
            row("containerH", pt(scrollState.scrollContainerHeight))
            row("viewportH", pt(scrollState.viewportHeight))
            row("distBottom", pt(scrollState.distanceFromBottom))
            row("distTop", pt(scrollState.distanceFromTop))
            row("pinnedLatest", bool(pinnedLatest))
            row("liveScrolling", bool(metrics.isLiveScrolling))
            row("paginating", bool(scrollState.isPaginationInFlight))
            row("pagInRange", bool(scrollState.wasPaginationTriggerInRange))
            row("ctaVisible", bool(scrollState.showScrollToLatest))
            row("updates/s", String(updatesPerSec))
            row("velocity", "\(signed(velocity)) pt/s")
            row("lastDeltaY", signed(metrics.lastDeltaY))
            // Highlight large single-frame contentH swings in red — these are
            // the LazyVStack height-estimate corrections we care about for
            // jerky-scroll investigation.
            row(
                "ΔcontentH",
                signed(metrics.lastContentHDelta),
                valueColor: abs(metrics.lastContentHDelta) > 100 ? VColor.systemNegativeStrong : nil
            )
            row("anchors/s", String(anchorsPerSec))
            row("anchorTotal", String(metrics.anchorShiftTotal))
            // Most recent anchor decision, tagged in red when it was a skip
            // accompanying a non-zero content change (i.e. a compensation we
            // missed). Applied events show the delta and age directly.
            row(
                "lastAnchor",
                anchorDecisionLabel(lastAnchor, ageMs: anchorAgeMs),
                valueColor: Self.isMissedCompensation(lastAnchor) ? VColor.systemNegativeStrong : nil
            )
            if let id = scrollState.currentConversationId {
                row("conv", String(id.uuidString.prefix(8)))
            }
            Divider()
                .padding(.top, 3)
            recordControl(now: now)
                .padding(.top, 3)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .font(.system(size: 10, design: .monospaced))
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(.ultraThinMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(VColor.borderBase, lineWidth: 0.5)
                )
        )
        .fixedSize()
        .accessibilityHidden(true)
    }

    private func recordControl(now: Date) -> some View {
        let elapsed: String = {
            guard recorder.isRecording, let start = recorder.sessionStartTime else { return "" }
            return String(format: "%.1fs", now.timeIntervalSince(start))
        }()
        let frameCount = recorder.frames.count

        return HStack(spacing: 6) {
            Button(action: toggleRecording) {
                HStack(spacing: 4) {
                    Circle()
                        .fill(recorder.isRecording ? VColor.systemNegativeStrong : Color.clear)
                        .overlay(
                            Circle().strokeBorder(
                                recorder.isRecording ? VColor.systemNegativeStrong : VColor.contentSecondary,
                                lineWidth: 1
                            )
                        )
                        .frame(width: 7, height: 7)
                    Text(recorder.isRecording ? "stop" : "rec")
                        .foregroundStyle(VColor.contentDefault)
                    if recorder.isRecording {
                        Text(elapsed)
                            .foregroundStyle(VColor.contentSecondary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(recorder.isRecording ? "Stop recording and save CSV to ~/Downloads" : "Start/resume recording per-frame scroll data (appends to existing buffer)")

            Spacer(minLength: 4)

            if frameCount > 0 {
                Text("\(frameCount)f")
                    .foregroundStyle(VColor.contentSecondary)

                Button(action: clearFrames) {
                    Text("clear")
                        .foregroundStyle(VColor.contentSecondary)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Discard the recording buffer")
            }
        }
    }

    private func toggleRecording() {
        if recorder.isRecording {
            if let url = recorder.stop() {
                NSWorkspace.shared.activateFileViewerSelecting([url])
            }
        } else {
            recorder.start()
        }
    }

    private func clearFrames() {
        recorder.clear()
    }

    private func row(_ label: String, _ value: String, valueColor: Color? = nil) -> some View {
        HStack(spacing: 6) {
            Text(label)
                .foregroundStyle(VColor.contentSecondary)
                .frame(width: 84, alignment: .trailing)
            Text(value)
                .foregroundStyle(valueColor ?? VColor.contentDefault)
                .frame(minWidth: 60, alignment: .leading)
        }
    }

    private func pt(_ v: CGFloat) -> String {
        guard v.isFinite else { return "∞" }
        return String(format: "%.1f", v)
    }

    private func signed(_ v: CGFloat) -> String {
        guard v.isFinite else { return "∞" }
        return String(format: "%+.1f", v)
    }

    private func bool(_ v: Bool) -> String { v ? "yes" : "no" }

    private func anchorDecisionLabel(_ event: ScrollAnchorDecisionEvent?, ageMs: Int?) -> String {
        guard let event, let ageMs else { return "—" }
        let prefix: String
        switch event.outcome {
        case .applied(let delta):
            prefix = "applied \(String(format: "%+.0f", delta))"
        case .skipped(let reason):
            prefix = "skip:\(reason.rawValue)"
        }
        return "\(prefix) @ \(ageMs)ms"
    }

    static func outcomeLabel(_ event: ScrollAnchorDecisionEvent) -> String {
        switch event.outcome {
        case .applied: return "applied"
        case .skipped(let reason): return reason.rawValue
        }
    }

    /// A skip that accompanied a real content-height change is a compensation
    /// we missed — this is the class of event the telemetry is meant to flag.
    static func isMissedCompensation(_ event: ScrollAnchorDecisionEvent?) -> Bool {
        guard let event else { return false }
        if case .skipped = event.outcome, event.contentHDelta != 0 { return true }
        return false
    }
}

// MARK: - ScrollDebugRecorder

/// Captures per-frame snapshots of the scroll metrics displayed in the HUD
/// and writes them as CSV to `~/Downloads` on stop. Only exists when the
/// scroll-debug overlay is mounted — all work happens on the main actor.
@Observable
@MainActor
final class ScrollDebugRecorder {
    /// Observed so the record button's label/indicator update when recording
    /// toggles. The frame buffer and session start are `@ObservationIgnored` —
    /// appending to them inside the HUD's body would otherwise invalidate
    /// the view and cause "modifying state during view update" warnings.
    var isRecording: Bool = false
    /// Set on each `start()` and cleared on `stop()` — drives the "3.2s"
    /// elapsed readout next to the stop button. Separate from CSV elapsed
    /// time, which is computed off the first frame's timestamp.
    @ObservationIgnored var sessionStartTime: Date?
    @ObservationIgnored var frames: [Frame] = []

    struct Frame {
        let timestamp: Date
        let offsetY: CGFloat
        let contentH: CGFloat
        let containerH: CGFloat
        let viewportH: CGFloat
        let distBottom: CGFloat
        let distTop: CGFloat
        let pinnedLatest: Bool
        let liveScrolling: Bool
        let paginating: Bool
        let paginationInRange: Bool
        let ctaVisible: Bool
        let updatesPerSecond: Int
        let velocity: CGFloat
        let lastDeltaY: CGFloat
        let lastContentHDelta: CGFloat
        let anchorsPerSecond: Int
        let anchorTotal: Int
        /// Outcome string of the most recent anchor decision: `"applied"` or
        /// the skip reason (`"notGrowth"`, `"pinnedToLatest"`, etc.). Empty
        /// before the first decision fires.
        let anchorOutcome: String
        /// Delta applied by the anchor preserver on the most recent decision.
        /// `0` for skips.
        let anchorDelta: CGFloat
        /// Content-height delta the preserver saw on the most recent decision.
        /// Negative values mean content shrunk — the preserver currently does
        /// not compensate for shrinks.
        let anchorContentHDelta: CGFloat
        let anchorPreOffsetY: CGFloat
        let anchorPostOffsetY: CGFloat
        /// Milliseconds since the most recent anchor decision. `-1` before the
        /// first decision fires.
        let anchorAgeMs: Int
        let conversationId: UUID?
    }

    /// Begin (or resume) recording. Appends to the existing buffer — call
    /// `clear()` first for a fresh recording.
    func start() {
        sessionStartTime = Date()
        isRecording = true
    }

    func capture(_ frame: Frame) {
        guard isRecording else { return }
        // SwiftUI may re-evaluate the body more than once per display frame;
        // dedupe by timestamp so the CSV stays aligned to the timeline tick.
        if let last = frames.last, last.timestamp == frame.timestamp { return }
        frames.append(frame)
    }

    /// Stop recording and write the accumulated buffer to
    /// `~/Downloads/vellum-scroll-debug-<timestamp>.csv`. Frames are kept so
    /// a subsequent `start()` appends to the same buffer; call `clear()` to
    /// reset. Returns the written URL, or `nil` if the buffer was empty or
    /// the write failed.
    func stop() -> URL? {
        isRecording = false
        sessionStartTime = nil
        guard !frames.isEmpty else { return nil }
        return writeCSV(frames: frames)
    }

    /// Discard the buffer. Safe to call while recording — the next captured
    /// frame becomes the new anchor, and the HUD's elapsed readout restarts.
    func clear() {
        frames.removeAll(keepingCapacity: true)
        if isRecording {
            sessionStartTime = Date()
        } else {
            sessionStartTime = nil
        }
    }

    private func writeCSV(frames: [Frame]) -> URL? {
        guard let start = frames.first?.timestamp else { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        var csv = "elapsedSec,timestamp,offsetY,contentH,containerH,viewportH,distBottom,distTop,pinnedLatest,liveScrolling,paginating,paginationInRange,ctaVisible,updatesPerSecond,velocity,lastDeltaY,lastContentHDelta,anchorsPerSecond,anchorTotal,anchorOutcome,anchorDelta,anchorContentHDelta,anchorPreOffsetY,anchorPostOffsetY,anchorAgeMs,conversationId\n"
        csv.reserveCapacity(frames.count * 240)
        for frame in frames {
            let elapsed = frame.timestamp.timeIntervalSince(start)
            let cols: [String] = [
                String(format: "%.4f", elapsed),
                iso.string(from: frame.timestamp),
                String(format: "%.2f", frame.offsetY),
                String(format: "%.2f", frame.contentH),
                String(format: "%.2f", frame.containerH),
                String(format: "%.2f", frame.viewportH),
                String(format: "%.2f", frame.distBottom),
                String(format: "%.2f", frame.distTop),
                frame.pinnedLatest ? "1" : "0",
                frame.liveScrolling ? "1" : "0",
                frame.paginating ? "1" : "0",
                frame.paginationInRange ? "1" : "0",
                frame.ctaVisible ? "1" : "0",
                String(frame.updatesPerSecond),
                String(format: "%.3f", frame.velocity),
                String(format: "%.3f", frame.lastDeltaY),
                String(format: "%.2f", frame.lastContentHDelta),
                String(frame.anchorsPerSecond),
                String(frame.anchorTotal),
                frame.anchorOutcome,
                String(format: "%.2f", frame.anchorDelta),
                String(format: "%.2f", frame.anchorContentHDelta),
                String(format: "%.2f", frame.anchorPreOffsetY),
                String(format: "%.2f", frame.anchorPostOffsetY),
                String(frame.anchorAgeMs),
                frame.conversationId?.uuidString ?? "",
            ]
            csv.append(cols.joined(separator: ","))
            csv.append("\n")
        }

        let nameFormatter = DateFormatter()
        nameFormatter.dateFormat = "yyyy-MM-dd-HHmmss"
        nameFormatter.locale = Locale(identifier: "en_US_POSIX")
        let filename = "vellum-scroll-debug-\(nameFormatter.string(from: start)).csv"

        let directory = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let url = directory.appendingPathComponent(filename)

        do {
            try csv.write(to: url, atomically: true, encoding: .utf8)
            return url
        } catch {
            NSLog("ScrollDebugRecorder: failed to write \(url.path): \(error)")
            return nil
        }
    }
}
