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

        return VStack(alignment: .leading, spacing: 1) {
            row("offsetY", pt(scrollState.lastContentOffsetY))
            row("contentH", pt(scrollState.scrollContentHeight))
            row("containerH", pt(scrollState.scrollContainerHeight))
            row("viewportH", pt(scrollState.viewportHeight))
            row("distBottom", pt(scrollState.distanceFromBottom))
            row("distTop", pt(scrollState.distanceFromTop))
            row("pinnedLatest", bool(scrollState.lastContentOffsetY.magnitude < pinnedEpsilon))
            row("liveScrolling", bool(metrics.isLiveScrolling))
            row("paginating", bool(scrollState.isPaginationInFlight))
            row("pagInRange", bool(scrollState.wasPaginationTriggerInRange))
            row("ctaVisible", bool(scrollState.showScrollToLatest))
            row("updates/s", String(metrics.updatesPerSecond(at: now)))
            row("velocity", "\(signed(metrics.displayedVelocity(at: now))) pt/s")
            row("lastDeltaY", signed(metrics.lastDeltaY))
            row("anchors/s", String(metrics.anchorShiftsPerSecond(at: now)))
            row("anchorTotal", String(metrics.anchorShiftTotal))
            if let id = scrollState.currentConversationId {
                row("conv", String(id.uuidString.prefix(8)))
            }
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
        .allowsHitTesting(false)
        .accessibilityHidden(true)
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
