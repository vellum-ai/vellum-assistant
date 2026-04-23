import SwiftUI
import VellumAssistantShared

/// Stub body component for updates-list detail panels.
/// Will be replaced with a rich list UI when the daemon surfaces
/// structured update items on `FeedItem`.
struct HomeUpdatesListDetailCard: View {
    let item: FeedItem

    var body: some View {
        Text(item.title)
            .font(VFont.bodyMediumDefault)
            .foregroundStyle(VColor.contentSecondary)
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
