import SwiftUI
import VellumAssistantShared

/// Body component for payment-authorization detail panels.
///
/// Reads structured fields from `FeedItem.metadata`:
///   - `amount` (String) — the payment amount (e.g. "$42.99")
///   - `merchant` (String) — merchant name
///   - `cardLast4` (String?) — last four digits of the card
///   - `status` (String?) — authorization status label
///
/// Falls back to `item.title` when metadata is absent or missing
/// the required keys.
struct HomeAuthDetailCard: View {
    let item: FeedItem

    // MARK: - Metadata accessors

    private var merchant: String? {
        item.metadata?["merchant"]?.value as? String
    }

    private var amount: String? {
        item.metadata?["amount"]?.value as? String
    }

    private var cardLast4: String? {
        item.metadata?["cardLast4"]?.value as? String
    }

    private var status: String? {
        item.metadata?["status"]?.value as? String
    }

    /// Whether the metadata contains enough data to render the rich layout.
    private var hasStructuredData: Bool {
        merchant != nil && amount != nil
    }

    // MARK: - Body

    var body: some View {
        if hasStructuredData {
            structuredContent
        } else {
            fallbackContent
        }
    }

    // MARK: - Structured layout

    private var structuredContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Merchant name
            Text(merchant ?? "")
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentDefault)

            // Amount — prominent display
            Text(amount ?? "")
                .font(VFont.titleLarge)
                .foregroundStyle(VColor.contentEmphasized)

            // Card info (secondary)
            if let last4 = cardLast4 {
                HStack(spacing: VSpacing.xs) {
                    Text("Card ending in")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    Text(last4)
                        .font(VFont.bodyMediumEmphasised)
                        .foregroundStyle(VColor.contentSecondary)
                }
            }

            // Status badge
            if let statusText = status {
                statusBadge(statusText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
    }

    // MARK: - Status badge

    private func statusBadge(_ text: String) -> some View {
        let (foreground, background) = statusColors(for: text)
        return Text(text.capitalized)
            .font(VFont.bodySmallEmphasised)
            .foregroundStyle(foreground)
            .padding(EdgeInsets(top: VSpacing.xxs, leading: VSpacing.sm, bottom: VSpacing.xxs, trailing: VSpacing.sm))
            .background(
                RoundedRectangle(cornerRadius: VRadius.sm, style: .continuous)
                    .fill(background)
            )
    }

    /// Maps a status string to foreground + background color pairs.
    private func statusColors(for status: String) -> (Color, Color) {
        switch status.lowercased() {
        case "approved", "completed":
            return (VColor.systemPositiveStrong, VColor.systemPositiveWeak)
        case "declined", "failed":
            return (VColor.systemNegativeStrong, VColor.systemNegativeWeak)
        case "pending":
            return (VColor.systemMidStrong, VColor.systemMidWeak)
        default:
            return (VColor.contentSecondary, VColor.surfaceActive)
        }
    }

    // MARK: - Fallback

    private var fallbackContent: some View {
        Text(item.title)
            .font(VFont.bodyMediumDefault)
            .foregroundStyle(VColor.contentSecondary)
            .padding(VSpacing.lg)
    }
}
