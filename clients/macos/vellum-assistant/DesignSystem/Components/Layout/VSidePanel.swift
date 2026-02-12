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
                    .font(VFont.display)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                if let onClose = onClose {
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(VColor.textMuted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Close \(title)")
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

#Preview("VSidePanel") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VSidePanel(title: "Inspector", onClose: {}) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Panel content here")
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                Text("With scrollable content area")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }
        }
    }
    .frame(width: 300, height: 300)
}
