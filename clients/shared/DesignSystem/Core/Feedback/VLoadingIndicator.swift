import SwiftUI

public struct VLoadingIndicator: View {
    public var size: CGFloat = 20
    public var color: Color = VColor.primaryBase

    @State private var isAnimating = false

    public init(size: CGFloat = 20, color: Color = VColor.primaryBase) {
        self.size = size
        self.color = color
    }

    public var body: some View {
        Circle()
            .trim(from: 0, to: 0.7)
            .stroke(color, lineWidth: 2)
            .frame(width: size, height: size)
            .rotationEffect(Angle(degrees: isAnimating ? 360 : 0))
            .onAppear {
                withAnimation(.linear(duration: 0.8).repeatForever(autoreverses: false)) {
                    isAnimating = true
                }
            }
            .onDisappear {
                isAnimating = false
            }
    }
}

#Preview("VLoadingIndicator") {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
        HStack(spacing: 24) {
            VLoadingIndicator(size: 14)
            VLoadingIndicator()
            VLoadingIndicator(size: 32)
            VLoadingIndicator(color: VColor.systemPositiveStrong)
            VLoadingIndicator(color: VColor.systemNegativeStrong)
        }
        .padding()
    }
    .frame(width: 350, height: 100)
}
