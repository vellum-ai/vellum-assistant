import SwiftUI

struct VSidePanel<PinnedContent: View, Content: View>: View {
    let title: String
    var onClose: (() -> Void)? = nil
    @ViewBuilder let pinnedContent: () -> PinnedContent
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Text(title.uppercased())
                    .font(VFont.panelTitle)
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
            .padding(VSpacing.lg)

            Divider()
                .background(VColor.surfaceBorder)

            // Pinned content (not scrollable)
            pinnedContent()

            // Scrollable content
            ScrollView {
                content()
                    .padding(VSpacing.xl)
            }
        }
        .background(VColor.backgroundSubtle)
    }
}

// Backward-compatible init (no pinnedContent)
extension VSidePanel where PinnedContent == EmptyView {
    init(title: String, onClose: (() -> Void)? = nil,
         @ViewBuilder content: @escaping () -> Content) {
        self.init(title: title, onClose: onClose,
                  pinnedContent: { EmptyView() }, content: content)
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
