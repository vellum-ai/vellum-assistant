import Foundation
import SwiftUI
import VellumAssistantShared

/// Per-conversation cache of each transcript row's measured height, keyed by
/// the row's `TranscriptItem.id`. Written on every render via the geometry
/// reader inside `CachedHeightRow`; read only by the scroll debug HUD today
/// (and by future diagnostics that want a ground-truth height per row).
///
/// The `message-height-cache` feature flag flips the stack from `LazyVStack`
/// to a plain `VStack` inside `MessageListContentView`. That's what actually
/// stabilises `scrollContentHeight` — `VStack` measures every cell, so the
/// scroll view reports the true total height instead of `LazyVStack`'s
/// drifting estimate. The cache itself is complementary: it records every
/// row's measured height as a byproduct, useful for inspection.
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

/// Wraps a transcript row so its measured height is recorded into the shared
/// `MessageHeightCache`. Does NOT pin the row's frame — an earlier version
/// applied `.frame(height: cached)` and produced catastrophic overlap when a
/// row's content grew past its first-measured height (streaming, thinking
/// block expanding). The row-height fix now lives at the stack level: the
/// enclosing `MessageListContentView` swaps `LazyVStack` for a plain `VStack`
/// when this flag is on, which eliminates the estimator that caused the
/// jerky scroll in the first place.
///
/// When the flag is off the wrapper is a straight passthrough — no geometry
/// reader, no cache writes — so off-state pays nothing.
struct CachedHeightRow<Content: View>: View {
    let itemId: UUID
    @ViewBuilder let content: () -> Content
    @Environment(\.messageHeightCache) private var heightCache

    var body: some View {
        if MacOSClientFeatureFlagManager.shared.isEnabled("message-height-cache") {
            content()
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

// MARK: - MessageTranscriptStack

/// Container for the transcript's main content stack. When the
/// `message-height-cache` flag is on, this is a plain `VStack` — every row
/// is materialised eagerly, so `scrollContentHeight` equals the true sum of
/// row heights with no estimator in the middle to drift. When the flag is
/// off this is the original `LazyVStack`, preserving the existing laziness
/// (and its estimation quirks) for conversations long enough that eager
/// layout would be too expensive.
///
/// The flag toggle is a clean A/B: correctness vs. laziness.
struct MessageTranscriptStack<Content: View>: View {
    let spacing: CGFloat
    @ViewBuilder let content: () -> Content

    var body: some View {
        if MacOSClientFeatureFlagManager.shared.isEnabled("message-height-cache") {
            VStack(alignment: .leading, spacing: spacing) {
                content()
            }
        } else {
            LazyVStack(alignment: .leading, spacing: spacing) {
                content()
            }
        }
    }
}
