import SwiftUI
import VellumAssistantShared

/// Centered empty state shown when all home feed sections are empty.
struct HomeEmptyState: View {
    var body: some View {
        VEmptyState(
            title: "You're caught up",
            subtitle: "Nothing new since we last talked.",
            icon: VIcon.circleCheck.rawValue
        )
    }
}
