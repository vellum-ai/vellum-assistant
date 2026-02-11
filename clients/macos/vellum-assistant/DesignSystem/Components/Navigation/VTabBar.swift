import SwiftUI

struct VTabBar<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: VSpacing.xs) {
                content()
            }
            .padding(.horizontal, VSpacing.lg)
        }
        .frame(height: 36)
        .background(VColor.backgroundSubtle)
    }
}
