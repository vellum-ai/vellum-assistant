import SwiftUI

struct VSegmentedControl: View {
    let items: [String]
    @Binding var selection: Int

    var body: some View {
        HStack(spacing: 0) {
            ForEach(items.indices, id: \.self) { index in
                Button(action: { selection = index }) {
                    VStack(spacing: VSpacing.xs) {
                        Text(items[index])
                            .font(VFont.captionMedium)
                            .foregroundColor(selection == index ? VColor.textPrimary : VColor.textMuted)
                            .padding(.horizontal, VSpacing.xl)
                            .padding(.vertical, VSpacing.sm)

                        Rectangle()
                            .fill(selection == index ? VColor.accent : .clear)
                            .frame(height: 2)
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }
}
