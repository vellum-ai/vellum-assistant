import SwiftUI

public struct PanelBackgroundModifier: ViewModifier {
    public init() {}

    public func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(VColor.surfaceBase)
    }
}

public extension View {
    func vPanelBackground() -> some View {
        modifier(PanelBackgroundModifier())
    }
}

#Preview("PanelBackground") {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
        HStack(spacing: 0) {
            Text("Main area")
                .foregroundColor(VColor.contentDefault)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            Text("Panel area")
                .foregroundColor(VColor.contentDefault)
                .frame(width: 150)
                .vPanelBackground()
        }
    }
    .frame(width: 400, height: 200)
}
