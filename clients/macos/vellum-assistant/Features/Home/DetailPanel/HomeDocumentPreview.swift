import SwiftUI
import VellumAssistantShared

/// Pure body content for the Home detail side panel's document/file
/// preview variant. Figma: node `3596:79401` (New App).
///
/// Renders a supplied `NSImage` scaled to fit the available width, or a
/// placeholder block (file icon + caption) when no preview image is
/// available. Generic over the file type — images render inline,
/// PDFs/documents/other attachments fall through to the placeholder for
/// now with their caption set by the caller (e.g. "Attachment preview
/// unavailable", "3 pages · PDF", filename, etc.).
///
/// Optional footer: a right-aligned row of ``Action`` buttons at the
/// bottom of the panel body. Typical usage is 0, 1, or 2 actions — per
/// the Figma mock the secondary is `.outlined` and the primary is
/// `.primary` — but the component accepts any count. Pass an empty
/// array to hide the footer entirely.
///
/// This view is intentionally just body content: the enclosing
/// ``HomeDetailPanel`` chrome supplies the header (filename as title,
/// "Go to Thread" + dismiss), so this component takes no title / dismiss
/// / thread props. Pair with `HomeDetailPanel(title: filename, …)`.
struct HomeDocumentPreview: View {
    /// A single footer action button.
    struct Action {
        let label: String
        var style: VButton.Style = .outlined
        let action: () -> Void
    }

    let image: NSImage?
    let placeholderCaption: String?
    /// Right-aligned footer actions. Empty = no footer rendered.
    /// Per the Figma mock, a secondary action (`.outlined`) comes first
    /// and the primary (`.primary`) comes last.
    var actions: [Action] = []

    var body: some View {
        VStack(spacing: 0) {
            preview
                .padding(VSpacing.lg)
                // Flex to fill the full remaining vertical space between the
                // panel chrome and the footer so the preview fits naturally
                // without a scroll view. Pair with `HomeDetailPanel(scrollable: false, …)`.
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                .layoutPriority(1)

            if !actions.isEmpty {
                VColor.borderBase
                    .frame(height: 1)
                    .accessibilityHidden(true)

                HStack(spacing: VSpacing.sm) {
                    Spacer(minLength: 0)
                    ForEach(Array(actions.enumerated()), id: \.offset) { _, action in
                        VButton(
                            label: action.label,
                            style: action.style,
                            size: .regular,
                            action: action.action
                        )
                    }
                }
                .padding(VSpacing.lg)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    @ViewBuilder
    private var preview: some View {
        if let image {
            // `.aspectRatio(contentMode: .fit)` respects BOTH dimensions of
            // the enclosing frame — the image scales down to whichever is
            // the tighter constraint so it never overflows.
            Image(nsImage: image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: VSpacing.sm) {
                VIconView(.file, size: 32)
                    .foregroundStyle(VColor.contentDisabled)
                Text(placeholderCaption ?? "Preview unavailable")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            .background(
                RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous)
                    .fill(VColor.surfaceOverlay)
            )
        }
    }
}
