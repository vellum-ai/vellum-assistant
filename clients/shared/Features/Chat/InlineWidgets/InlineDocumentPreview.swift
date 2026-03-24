import SwiftUI

/// Compact preview card for documents shown inline in chat.
/// The entire card is clickable to open the document editor panel.
public struct InlineDocumentPreview: View {
    public let data: DocumentPreviewSurfaceData
    public let onOpen: () -> Void

    public init(data: DocumentPreviewSurfaceData, onOpen: @escaping () -> Void) {
        self.data = data
        self.onOpen = onOpen
    }

    public var body: some View {
        Button {
            onOpen()
        } label: {
            HStack(spacing: VSpacing.sm) {
                VIconView(.fileText, size: 20)
                    .foregroundColor(VColor.primaryBase)

                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text(data.title)
                        .font(VFont.bodyMediumEmphasised)
                        .foregroundColor(VColor.contentDefault)
                        .lineLimit(2)

                    if let subtitle = data.subtitle {
                        Text(subtitle)
                            .font(VFont.labelDefault)
                            .foregroundColor(VColor.contentTertiary)
                            .lineLimit(1)
                    }
                }

                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open document: \(data.title)")
        .accessibilityAddTraits(.isButton)
    }
}
