import SwiftUI

/// A view whose sole purpose is to create a separate SwiftUI observation
/// scope for its content. The `@ViewBuilder` closure is stored (not
/// eagerly evaluated) and invoked during *this* view's body evaluation,
/// so any `@Observable` property reads inside the closure are tracked
/// in `ObservationBoundaryView`'s scope rather than the parent view's.
///
/// This is the standard "deferred body" pattern recommended for narrowing
/// observation scope without moving large amounts of intertwined code.
/// Each `ObservationBoundaryView` instance appears as a distinct node in
/// SwiftUI's AttributeGraph, receiving its own observation tracking
/// context (ref: WWDC23 — Discover Observation in SwiftUI).
struct ObservationBoundaryView<Content: View>: View {
    private let build: () -> Content

    init(@ViewBuilder content: @escaping () -> Content) {
        self.build = content
    }

    var body: some View {
        build()
    }
}
