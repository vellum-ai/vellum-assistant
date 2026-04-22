import SwiftUI
import VellumAssistantShared

/// Pure body content for the Home detail side panel's email composer
/// variant.
///
/// Based on Figma node `3496:72522`, with the formatting toolbar moved
/// to sit between the subject divider and the body text (so the
/// To/Subject metadata reads as a header block and the toolbar frames
/// the composable body). Layout: To/Subject labeled fields, formatting
/// toolbar, editable body text, and at the bottom a two-row footer: a
/// horizontal scroll of attachment chips (only when attachments are
/// present) followed by a primary `Send` button. The
/// enclosing `HomeDetailPanel` chrome supplies the header title +
/// optional dismiss; the `Send` action lives on this component rather
/// than on the panel header because the mock puts it at the bottom of
/// the panel, not in the header.
///
/// The body text field expands to fill all vertical space between the
/// subject divider and the attachments/send footer, so the footer
/// always anchors to the bottom of the panel regardless of how much
/// body text is present. This requires the enclosing `HomeDetailPanel`
/// to be constructed with `scrollable: false` so that the editor's own
/// vertical growth can be honored. With the default `scrollable: true`
/// the body falls back to its intrinsic height (no fill), which reads
/// fine but leaves whitespace between the body and the footer.
struct HomeEmailEditor: View {

    struct Attachment: Identifiable, Hashable {
        let id: UUID
        let fileName: String
        let fileSize: String
    }

    @Binding var toAddress: String
    @Binding var subject: String
    @Binding var bodyText: String
    let attachments: [Attachment]
    let onAttachmentTap: (Attachment) -> Void
    /// Fired when the user taps the footer `Send` button.
    let onSend: () -> Void
    var onFormatAction: (VFormattingToolbar.Action) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Full-bleed divider flush to the panel edges separates the
            // enclosing HomeDetailPanel header from the editor fields.
            VColor.borderBase
                .frame(height: 1)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 0) {
                labeledField("to:", $toAddress)

                insetHairline

                labeledField("subject:", $subject)

                insetHairline
            }

            // Formatting toolbar sits between the subject divider and the
            // body text, so the fields read as a metadata header and the
            // toolbar frames the composable content below it.
            VFormattingToolbar(onAction: onFormatAction)

            insetHairline

            TextField("Compose your reply…", text: $bodyText, axis: .vertical)
                .textFieldStyle(.plain)
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentDefault)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(VSpacing.md)

            if !attachments.isEmpty {
                insetHairline

                attachmentsRow
            }

            insetHairline

            sendFooter
        }
    }

    /// 1pt hairline inset by `VSpacing.lg` on each side so it stops short
    /// of the panel's rounded edges — matches the Figma mock, where every
    /// divider except the one directly under the header is held in from
    /// the panel edges.
    private var insetHairline: some View {
        VColor.borderBase
            .frame(height: 1)
            .padding(.horizontal, VSpacing.lg)
            .accessibilityHidden(true)
    }

    // MARK: - Footer sub-views

    /// Horizontal chip row matching Figma node `3496:72524-29`. Rendered
    /// above the send button when `attachments` is non-empty.
    private var attachmentsRow: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Attachments")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
                .accessibilityAddTraits(.isHeader)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: VSpacing.sm) {
                    ForEach(attachments) { att in
                        Button {
                            onAttachmentTap(att)
                        } label: {
                            HomeLinkFileRow(
                                icon: .file,
                                fileName: att.fileName,
                                fileSize: att.fileSize
                            )
                        }
                        .buttonStyle(.plain)
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(att.fileName), \(att.fileSize)")
                    }
                }
            }
        }
        .padding(EdgeInsets(
            top: VSpacing.sm,
            leading: VSpacing.lg,
            bottom: VSpacing.sm,
            trailing: VSpacing.lg
        ))
    }

    /// Primary send action anchored to the bottom of the panel. Uses
    /// `VButton.Size.regular` (32pt tall, 8pt corners) to match the
    /// Figma spec exactly (node `3496:72533`).
    private var sendFooter: some View {
        HStack(spacing: 0) {
            VButton(
                label: "Send",
                style: .primary,
                size: .regular,
                action: onSend
            )
            Spacer(minLength: 0)
        }
        .padding(EdgeInsets(
            top: VSpacing.md,
            leading: VSpacing.lg,
            bottom: VSpacing.lg,
            trailing: VSpacing.lg
        ))
    }

    // MARK: - Labeled field

    /// Row that renders a fixed prefix (e.g. `to:`, `subject:`) followed
    /// by an editable text field. The prefix is rendered as real text, not
    /// a `TextField` placeholder, so it stays visible once the user has
    /// typed a value — matches the Figma mock's "to: john@johnstown.com"
    /// single-line rendering.
    @ViewBuilder
    private func labeledField(_ label: String, _ value: Binding<String>) -> some View {
        HStack(spacing: VSpacing.xs) {
            Text(label)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
                .accessibilityHidden(true)

            TextField("", text: value)
                .textFieldStyle(.plain)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
                .accessibilityLabel(Text(label))
        }
        .padding(EdgeInsets(top: VSpacing.sm, leading: VSpacing.lg, bottom: VSpacing.sm, trailing: VSpacing.lg))
    }
}
