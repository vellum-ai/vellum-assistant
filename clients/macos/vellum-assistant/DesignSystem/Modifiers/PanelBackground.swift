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
