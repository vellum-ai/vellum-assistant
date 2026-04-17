import SwiftUI
import VellumAssistantShared

/// Pure body content for the Home detail side panel's invoice/document
/// preview variant.
///
/// Renders a supplied `NSImage` scaled to fit the available width, or a
/// placeholder block (document icon + caption) when no image is available
/// yet. Matches Figma mock node `3216:63118` — the Slack invoice
/// screenshot shown inside the auth/invoice side-panel variant.
///
/// This view is intentionally just body content: the enclosing
/// `HomeDetailPanel` chrome supplies the header, action buttons, and
/// dismiss affordance, so this component takes no header / title /
/// action / dismiss props.
struct HomeInvoicePreview: View {
    let image: NSImage?
    let placeholderCaption: String?

    var body: some View {
        VStack(spacing: 0) {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: .infinity, alignment: .top)
            } else {
                VStack(spacing: VSpacing.sm) {
                    VIconView(.file, size: 32)
                        .foregroundStyle(VColor.contentDisabled)
                    Text(placeholderCaption ?? "Invoice preview unavailable")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, minHeight: 400, alignment: .center)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous)
                        .fill(VColor.surfaceOverlay)
                )
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.top, VSpacing.lg)
        .padding(.bottom, VSpacing.lg)
        .frame(maxWidth: .infinity)
    }
}
