import Foundation
import SwiftUI

/// Per-conversation cache of each transcript row's measured height, keyed by
/// the row's `TranscriptItem.id`. Written on every render via the geometry
/// reader inside `CachedHeightRow`; read only by the scroll debug HUD today
/// (and by future diagnostics that want a ground-truth height per row).
///
/// The transcript uses a plain `VStack` inside `MessageListContentView`,
/// which measures every cell so the scroll view reports the true total height
/// without estimator drift. The cache records every row's measured height as
/// a byproduct, useful for inspection.
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
/// block expanding). The row-height fix lives at the stack level: the
/// enclosing `MessageListContentView` uses a plain `VStack`, which
/// eliminates the estimator that caused jerky scroll.
struct CachedHeightRow<Content: View>: View {
    let itemId: UUID
    @ViewBuilder let content: () -> Content
    @Environment(\.messageHeightCache) private var heightCache

    var body: some View {
        content()
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.size.height
            } action: { newHeight in
                heightCache.record(itemId, height: newHeight)
            }
    }
}

// MARK: - MessageTranscriptStack

/// Container for the transcript's main content stack. Uses a plain `VStack`
/// so every row is materialised eagerly and `scrollContentHeight` equals the
/// true sum of row heights with no estimator in the middle to drift.
struct MessageTranscriptStack<Content: View>: View {
    let spacing: CGFloat
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            content()
        }
    }
}
