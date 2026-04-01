import SwiftUI
import VellumAssistantShared

struct IntegrationCard: View {
    let providerKey: String
    let displayName: String
    let description: String?
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: VSpacing.md) {
                IntegrationIcon.image(for: providerKey, size: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(displayName)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)
                        .lineLimit(1)
                    if let description, !description.isEmpty {
                        Text(description)
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.contentTertiary)
                            .lineLimit(1)
                    }
                }
                Spacer()
                VIconView(.chevronRight, size: 12)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(isHovered ? VColor.surfaceActive : VColor.surfaceBase)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.borderBase, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }
}
