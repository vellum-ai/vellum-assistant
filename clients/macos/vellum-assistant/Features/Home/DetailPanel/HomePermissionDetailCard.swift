import SwiftUI
import VellumAssistantShared

/// Stub body component for tool-permission detail panels.
/// Will be replaced with a rich permission approval UI when the daemon
/// surfaces structured permission fields on `FeedItem`.
struct HomePermissionDetailCard: View {
    let item: FeedItem

    var body: some View {
        Text(item.title)
            .font(VFont.bodyMediumDefault)
            .foregroundStyle(VColor.contentSecondary)
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
