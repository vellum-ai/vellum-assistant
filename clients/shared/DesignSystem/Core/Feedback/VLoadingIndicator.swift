import SwiftUI

public struct VLoadingIndicator: View {
    public var size: CGFloat = 20
    public var color: Color = VColor.accent

    @State private var isAnimating = false

    public init(size: CGFloat = 20, color: Color = VColor.accent) {
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
        VColor.background.ignoresSafeArea()
        HStack(spacing: 24) {
            VLoadingIndicator(size: 14)
            VLoadingIndicator()
            VLoadingIndicator(size: 32)
            VLoadingIndicator(color: VColor.success)
            VLoadingIndicator(color: VColor.error)
        }
        .padding()
    }
    .frame(width: 350, height: 100)
}
