import Foundation
import SwiftUI
import VellumAssistantShared

/// Per-conversation cache of each transcript row's measured height, keyed by
/// the row's `TranscriptItem.id`. When enabled, the cached height is applied
/// back as a `.frame(height:)` so SwiftUI's `LazyVStack` reports an accurate
/// `contentSize` even for cells that are currently off-screen.
///
/// Without this, `LazyVStack` drifts its internal height estimate as cells
/// materialize — measurable as single-frame swings of hundreds of points in
/// `scrollContentHeight` that manifest as jerky scroll at the top of a long
/// conversation. See `ScrollDebugOverlayView` for the diagnostic HUD.
///
/// Invalidation: fully reset on conversation switch (via `.id(conversationId)`
/// on the hosting view), chat column width change, or typography generation
/// bump. Per-row entries are overwritten on every geometry update, so
/// streaming content keeps its cache entry up to date as it grows — subject
/// to a 1-frame lag while the body re-evaluates.
///
/// Propagated through `EnvironmentValues.messageHeightCache` alongside the
/// other transcript stores. Not annotated `@MainActor` because `EnvironmentKey`
/// default values must satisfy a nonisolated protocol requirement (same
/// constraint as `ThinkingBlockExpansionStore`). Mutations happen only from
/// SwiftUI view bodies, which are implicitly main-actor-isolated.
@Observable
final class MessageHeightCache: @unchecked Sendable {
    private var heights: [UUID: CGFloat] = [:]

    func height(for id: UUID) -> CGFloat? {
        heights[id]
    }

    /// Store a measured height. No-ops for non-finite, non-positive, or
    /// effectively-unchanged values so the caller can feed this directly
    /// from `.onGeometryChange` without extra guards.
    func record(_ id: UUID, height: CGFloat) {
        guard height.isFinite, height > 0 else { return }
        let rounded = (height * 2).rounded() / 2   // half-point precision
        if heights[id] == rounded { return }
        heights[id] = rounded
    }

    func reset() {
        heights.removeAll(keepingCapacity: true)
    }
}

private struct MessageHeightCacheKey: EnvironmentKey {
    static let defaultValue = MessageHeightCache()
}

extension EnvironmentValues {
    var messageHeightCache: MessageHeightCache {
        get { self[MessageHeightCacheKey.self] }
        set { self[MessageHeightCacheKey.self] = newValue }
    }
}

// MARK: - CachedHeightRow

/// Wraps a transcript row so its measured height is written back to the
/// shared `MessageHeightCache` and, on subsequent renders, pinned via
/// `.frame(height:)`. The pin is what lets `LazyVStack` skip re-estimating
/// the row when it scrolls off-screen and back on — which is what stabilises
/// `scrollContentHeight` during long-conversation scroll.
///
/// Gated on the `message-height-cache` macOS feature flag. When the flag is
/// off this view is a straight passthrough — no geometry reader, no frame
/// pin, no cache writes — so off-state pays nothing.
struct CachedHeightRow<Content: View>: View {
    let itemId: UUID
    @ViewBuilder let content: () -> Content
    @Environment(\.messageHeightCache) private var heightCache

    var body: some View {
        let flagEnabled = MacOSClientFeatureFlagManager.shared.isEnabled("message-height-cache")
        if flagEnabled {
            let cached = heightCache.height(for: itemId)
            Group {
                if let cached {
                    content().frame(height: cached)
                } else {
                    content()
                }
            }
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.size.height
            } action: { newHeight in
                heightCache.record(itemId, height: newHeight)
            }
        } else {
            content()
        }
    }
}
