import SwiftUI
import VellumAssistantShared

/// Stub body component for payment-authorization detail panels.
/// Will be replaced with a rich approval UI when the daemon surfaces
/// structured payment-auth fields on `FeedItem`.
struct HomeAuthDetailCard: View {
    let item: FeedItem

    var body: some View {
        Text(item.title)
            .font(VFont.bodyMediumDefault)
            .foregroundStyle(VColor.contentSecondary)
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
