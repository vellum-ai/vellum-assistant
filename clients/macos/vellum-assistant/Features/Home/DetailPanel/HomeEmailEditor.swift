import SwiftUI
import VellumAssistantShared

/// Pure body content for the Home detail side panel's email composer
/// variant.
///
/// Matches Figma node `3216:63021` — formatting toolbar, divider,
/// To/Subject labeled fields, editable body text, and a horizontal
/// scroll of attachment chips at the bottom. The enclosing
/// `HomeDetailPanel` chrome supplies the header, title, action buttons,
/// and dismiss affordance, so this component takes no header / title /
/// action / dismiss props — it's slotted directly into the panel's
/// `content:` closure.
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
    var onFormatAction: (VFormattingToolbar.Action) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VFormattingToolbar(onAction: onFormatAction)

            VColor.borderBase
                .frame(height: 1)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 0) {
                labeledField("to:", $toAddress)

                Divider()
                    .background(VColor.borderBase)
                    .accessibilityHidden(true)

                labeledField("subject:", $subject)

                Divider()
                    .background(VColor.borderBase)
                    .accessibilityHidden(true)
            }

            TextField("Compose your reply…", text: $bodyText, axis: .vertical)
                .textFieldStyle(.plain)
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentDefault)
                .frame(minHeight: 240, alignment: .topLeading)
                .padding(VSpacing.md)

            if !attachments.isEmpty {
                Divider()
                    .background(VColor.borderBase)
                    .accessibilityHidden(true)

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
                    bottom: VSpacing.lg,
                    trailing: VSpacing.lg
                ))
            }
        }
    }

    // MARK: - Labeled field

    @ViewBuilder
    private func labeledField(_ label: String, _ value: Binding<String>) -> some View {
        TextField(label, text: value)
            .textFieldStyle(.plain)
            .font(VFont.bodyMediumLighter)
            .foregroundStyle(VColor.contentSecondary)
            .padding(EdgeInsets(top: VSpacing.sm, leading: VSpacing.md, bottom: VSpacing.sm, trailing: VSpacing.md))
    }
}
