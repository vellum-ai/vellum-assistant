import SwiftUI

struct PanelBackgroundModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(VColor.backgroundSubtle)
    }
}

extension View {
    func vPanelBackground() -> some View {
        modifier(PanelBackgroundModifier())
    }
}

#Preview("PanelBackground") {
    ZStack {
        VColor.background.ignoresSafeArea()
        HStack(spacing: 0) {
            Text("Main area")
                .foregroundColor(VColor.textPrimary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            Text("Panel area")
                .foregroundColor(VColor.textPrimary)
                .frame(width: 150)
                .vPanelBackground()
        }
    }
    .frame(width: 400, height: 200)
}
