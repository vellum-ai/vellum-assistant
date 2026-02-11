import SwiftUI

struct VSidePanel<Content: View>: View {
    let title: String
    var onClose: (() -> Void)? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Text(title.uppercased())
                    .font(VFont.mono)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                if let onClose = onClose {
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(VColor.textMuted)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(VSpacing.xl)

            Divider()
                .background(VColor.surfaceBorder)

            // Content
            ScrollView {
                content()
                    .padding(VSpacing.xl)
            }
        }
        .background(VColor.backgroundSubtle)
    }
}
