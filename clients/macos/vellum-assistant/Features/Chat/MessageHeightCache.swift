import Foundation
import SwiftUI

/// Per-conversation cache of each transcript row's measured height, keyed by
/// the row's `TranscriptItem.id`. Written on every render via the geometry
/// reader inside `CachedHeightRow`; read by the scroll debug HUD and
/// future diagnostics that want a ground-truth height per row.
///
/// The transcript uses a `LazyVStack` inside `MessageListContentView`,
/// so only visible rows are measured per layout pass. The cache records
/// each row's measured height as it is materialised.
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
/// `MessageHeightCache`. Does NOT pin the row's frame — the enclosing
/// `MessageListContentView` uses a `LazyVStack`, which only measures
/// visible rows per layout pass. `LazyVStack` remembers each cell's last
/// measured height internally for off-screen sizing.
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

/// Container for the transcript's main content stack. Uses a `LazyVStack`
/// so only visible rows are measured per layout pass — preventing the
/// O(N) eager measurement that caused ≥ 2 000 ms main-thread hangs on
/// conversation switch, window resize, and typography changes.
///
/// The enclosing `MessageListContentView` applies
/// `.transaction { $0.animation = nil }` to suppress all insertion
/// animations. Without that suppressor, any animated insertion in a
/// `LazyVStack` triggers `motionVectors` — an O(n) `sizeThatFits` sweep
/// over ALL children that defeats lazy loading.
///
/// Trade-off vs the previous plain `VStack`: `LazyVStack` estimates
/// off-screen row heights from the average of measured rows instead of
/// knowing the true sum. This can cause minor scroll-position drift the
/// first time the user scrolls through unmeasured history. The drift is
/// bounded (progressive, not sudden) and corrects itself as rows are
/// materialised. The ≥ 2 s hang elimination is a net-positive trade.
struct MessageTranscriptStack<Content: View>: View {
    let spacing: CGFloat
    @ViewBuilder let content: () -> Content

    var body: some View {
        LazyVStack(alignment: .leading, spacing: spacing) {
            content()
        }
    }
}
