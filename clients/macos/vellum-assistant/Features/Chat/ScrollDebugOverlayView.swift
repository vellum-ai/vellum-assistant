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
                anchorsPerSecond: anchorsPerSec,
                anchorTotal: metrics.anchorShiftTotal,
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
            row("anchors/s", String(anchorsPerSec))
            row("anchorTotal", String(metrics.anchorShiftTotal))
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
            guard recorder.isRecording, let start = recorder.startTime else { return "" }
            return String(format: "%.1fs", now.timeIntervalSince(start))
        }()
        let frameCount = recorder.frames.count

        return Button(action: toggleRecording) {
            HStack(spacing: 4) {
                Circle()
                    .fill(recorder.isRecording ? Color.red : Color.clear)
                    .overlay(
                        Circle().strokeBorder(
                            recorder.isRecording ? Color.red : VColor.contentSecondary,
                            lineWidth: 1
                        )
                    )
                    .frame(width: 7, height: 7)
                Text(recorder.isRecording ? "stop" : "rec")
                    .foregroundStyle(VColor.contentDefault)
                if recorder.isRecording {
                    Text(elapsed)
                        .foregroundStyle(VColor.contentSecondary)
                    Spacer(minLength: 4)
                    Text("\(frameCount)f")
                        .foregroundStyle(VColor.contentSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(recorder.isRecording ? "Stop recording and save CSV to ~/Downloads" : "Start recording per-frame scroll data")
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

    private func row(_ label: String, _ value: String) -> some View {
        HStack(spacing: 6) {
            Text(label)
                .foregroundStyle(VColor.contentSecondary)
                .frame(width: 84, alignment: .trailing)
            Text(value)
                .foregroundStyle(VColor.contentDefault)
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
}

// MARK: - ScrollDebugRecorder

/// Captures per-frame snapshots of the scroll metrics displayed in the HUD
/// and writes them as CSV to `~/Downloads` on stop. Only exists when the
/// scroll-debug overlay is mounted — all work happens on the main actor.
@Observable
@MainActor
final class ScrollDebugRecorder {
    /// Observed so the record button's label/indicator update when recording
    /// toggles. The frame buffer and start time are `@ObservationIgnored` —
    /// appending to them inside the HUD's body would otherwise invalidate
    /// the view and cause "modifying state during view update" warnings.
    var isRecording: Bool = false
    @ObservationIgnored var startTime: Date?
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
        let anchorsPerSecond: Int
        let anchorTotal: Int
        let conversationId: UUID?
    }

    func start() {
        frames.removeAll(keepingCapacity: true)
        startTime = Date()
        isRecording = true
    }

    func capture(_ frame: Frame) {
        guard isRecording else { return }
        // SwiftUI may re-evaluate the body more than once per display frame;
        // dedupe by timestamp so the CSV stays aligned to the timeline tick.
        if let last = frames.last, last.timestamp == frame.timestamp { return }
        frames.append(frame)
    }

    /// Stop recording and write frames to `~/Downloads/vellum-scroll-debug-<timestamp>.csv`.
    /// Returns the written URL, or `nil` if there was nothing to write or the
    /// write failed.
    func stop() -> URL? {
        let captured = frames
        let start = startTime
        isRecording = false
        startTime = nil
        frames.removeAll(keepingCapacity: true)
        guard !captured.isEmpty, let start else { return nil }
        return writeCSV(frames: captured, start: start)
    }

    private func writeCSV(frames: [Frame], start: Date) -> URL? {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        var csv = "elapsedSec,timestamp,offsetY,contentH,containerH,viewportH,distBottom,distTop,pinnedLatest,liveScrolling,paginating,paginationInRange,ctaVisible,updatesPerSecond,velocity,lastDeltaY,anchorsPerSecond,anchorTotal,conversationId\n"
        csv.reserveCapacity(frames.count * 180)
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
                String(frame.anchorsPerSecond),
                String(frame.anchorTotal),
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
