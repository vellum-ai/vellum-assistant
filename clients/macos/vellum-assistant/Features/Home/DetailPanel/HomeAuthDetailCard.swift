import SwiftUI
import VellumAssistantShared

/// Body component for payment-authorization detail panels.
///
/// Renders structured payment info — amount, recipient, and an optional
/// caption — as a compact card above the document/invoice preview. When
/// no structured data is available the component renders nothing, letting
/// the parent panel fall back to the default placeholder.
struct HomeAuthDetailCard: View {
    let amount: String?
    let recipient: String?
    let caption: String?

    var body: some View {
        let hasContent = amount != nil || recipient != nil || caption != nil
        if hasContent {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                if let amount {
                    HStack(spacing: VSpacing.xs) {
                        Text("Amount")
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentTertiary)
                        Spacer()
                        Text(amount)
                            .font(VFont.bodyMediumEmphasised)
                            .foregroundStyle(VColor.contentEmphasized)
                    }
                }

                if let recipient {
                    HStack(spacing: VSpacing.xs) {
                        Text("Recipient")
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentTertiary)
                        Spacer()
                        Text(recipient)
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentDefault)
                    }
                }

                if let caption {
                    Text(caption)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(VSpacing.lg)
        }
    }
}
