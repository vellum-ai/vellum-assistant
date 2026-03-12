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

