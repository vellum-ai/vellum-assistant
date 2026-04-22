import SwiftUI
import VellumAssistantShared

/// Pure body content for the Home detail side panel's email composer
/// variant.
///
/// Based on Figma nodes `3496:72522` (body/fields) and `3679:20570`
/// (panel chrome + footer). Layout: To/Subject labeled fields, editable
/// body text, optional attachments row, an optional "Connect Google"
/// banner when Gmail isn't connected, and a right-aligned footer with
/// two actions — a secondary `Discard` (outlined) and a primary button
/// that reads `Send` when Gmail is connected or `Copy to Clipboard`
/// (with a copy icon) when it isn't. The enclosing `HomeDetailPanel`
/// chrome supplies the header title and dismiss control.
///
/// The body text field expands to fill all vertical space between the
/// subject divider and the attachments/footer, so the footer always
/// anchors to the bottom of the panel regardless of how much body
/// text is present. This requires the enclosing `HomeDetailPanel` to
/// be constructed with `scrollable: false` so the editor's own vertical
/// growth can be honored. With the default `scrollable: true` the body
/// falls back to its intrinsic height (no fill), which reads fine but
/// leaves whitespace between the body and the footer.
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
    /// Whether the user has connected Google OAuth (i.e. the assistant
    /// can send emails on their behalf). Drives two pieces of UI:
    /// • When false, a "Connect Google" banner appears above the footer.
    /// • When false, the primary footer CTA becomes "Copy to Clipboard"
    ///   (with a copy icon) instead of "Send".
    /// Defaults to `true` so pre-existing callers that haven't wired the
    /// signal keep rendering the Send-first flow.
    var isGmailConnected: Bool = true
    /// Fired when the user taps Send (only surfaced when `isGmailConnected`).
    let onSend: () -> Void
    /// Fired when the user taps Copy to Clipboard (only surfaced when
    /// `isGmailConnected == false`). Defaults to a no-op so the component
    /// doesn't force callers to wire both code paths up front.
    var onCopyToClipboard: () -> Void = {}
    /// Fired when the user taps Discard.
    let onDiscard: () -> Void
    /// Fired when the user taps the Connect button in the banner.
    /// Only surfaced when `isGmailConnected == false`. Defaults to a
    /// no-op so the component doesn't force callers to wire the OAuth
    /// flow up front; the banner can still render as informational.
    var onConnectGoogle: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Full-bleed divider flush to the panel edges separates the
            // enclosing HomeDetailPanel header from the editor fields.
            VColor.borderHover
                .frame(height: 1)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 0) {
                labeledField("to:", $toAddress)

                insetHairline

                labeledField("subject:", $subject)

                insetHairline
            }

            TextField("Compose your reply…", text: $bodyText, axis: .vertical)
                .textFieldStyle(.plain)
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentDefault)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(EdgeInsets(
                    top: VSpacing.md,
                    leading: VSpacing.lg,
                    bottom: VSpacing.md,
                    trailing: VSpacing.lg
                ))

            if !attachments.isEmpty {
                insetHairline

                attachmentsRow
            }

            if !isGmailConnected {
                insetHairline

                connectBanner
            }

            insetHairline

            actionFooter
        }
    }

    /// 1pt hairline inset by `VSpacing.lg` on each side so it stops short
    /// of the panel's rounded edges — matches the Figma mock, where every
    /// divider except the one directly under the header is held in from
    /// the panel edges.
    private var insetHairline: some View {
        VColor.borderHover
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

    /// Right-aligned footer with the secondary Discard button and the
    /// primary CTA. Matches Figma node `3679:20570`'s footer row:
    /// 16pt padding on all sides, 8pt gap between buttons, both 32pt
    /// tall with 8pt corners, the discard outlined in `borderElement`
    /// and the primary filled with `contentEmphasized`.
    ///
    /// The primary button's label depends on `isGmailConnected`:
    /// "Send" when connected, "Copy to Clipboard" (with a copy icon)
    /// when not.
    private var actionFooter: some View {
        HStack(alignment: .center, spacing: VSpacing.sm) {
            Spacer(minLength: 0)

            discardButton

            if isGmailConnected {
                sendPrimaryButton
            } else {
                copyPrimaryButton
            }
        }
        .padding(VSpacing.lg)
    }

    private var discardButton: some View {
        Button(action: onDiscard) {
            Text("Discard")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentEmphasized)
                .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
                .frame(height: 32)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md, style: .continuous)
                        .strokeBorder(VColor.borderElement, lineWidth: 1)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .accessibilityLabel(Text("Discard"))
    }

    private var sendPrimaryButton: some View {
        Button(action: onSend) {
            Text("Send")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentInset)
                .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
                .frame(height: 32)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md, style: .continuous)
                        .fill(VColor.contentEmphasized)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .accessibilityLabel(Text("Send"))
    }

    private var copyPrimaryButton: some View {
        Button(action: onCopyToClipboard) {
            HStack(spacing: VSpacing.xs) {
                VIconView(.copy, size: 12)
                    .foregroundStyle(VColor.contentInset)
                Text("Copy to Clipboard")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentInset)
            }
            .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
            .frame(height: 32)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md, style: .continuous)
                    .fill(VColor.contentEmphasized)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("Copy to Clipboard"))
    }

    /// Banner shown above the footer when Gmail isn't connected. Offers
    /// the assistant-to-Google OAuth flow and explains why the primary
    /// CTA is "Copy to Clipboard" for now.
    private var connectBanner: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            VIconView(.info, size: 14)
                .foregroundStyle(VColor.systemInfoStrong)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text("Connect to Google OAuth to send directly")
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentEmphasized)
                Text("Until then, copy this draft to your clipboard and paste it into Gmail.")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: VSpacing.sm)

            Button(action: onConnectGoogle) {
                Text("Connect")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.systemInfoStrong)
                    .underline()
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .accessibilityLabel(Text("Connect Google"))
        }
        .padding(EdgeInsets(
            top: VSpacing.md,
            leading: VSpacing.lg,
            bottom: VSpacing.md,
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
