import SwiftUI
import VellumAssistantShared

// MARK: - Spinning Refresh Icon

struct SpinningRefreshIcon: View {
    let isSpinning: Bool

    @State private var angle: Double = 0

    var body: some View {
        VIconView(.refreshCw, size: 11)
            .foregroundStyle(isSpinning ? VColor.primaryBase : VColor.contentTertiary)
            .rotationEffect(.degrees(angle))
            .frame(width: 24, height: 24)
            .contentShape(Rectangle())
            .task(id: isSpinning) {
                if isSpinning {
                    angle = 0
                    while !Task.isCancelled {
                        withAnimation(.linear(duration: 1)) {
                            angle += 360
                        }
                        try? await Task.sleep(nanoseconds: 1_000_000_000)
                    }
                } else {
                    angle = 0
                }
            }
    }
}
