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
                            .padding(.vertical, VSpacing.xs)

                        Rectangle()
                            .fill(selection == index ? VColor.accent : .clear)
                            .frame(height: 2)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(items[index])
                .accessibilityAddTraits(selection == index ? .isSelected : [])
            }
            Spacer()
        }
        .padding(.horizontal, VSpacing.sm)
    }
}

#if DEBUG
struct VSegmentedControl_Preview: PreviewProvider {
    static var previews: some View {
        VSegmentedControlPreviewWrapper()
            .frame(width: 500, height: 60)
            .previewDisplayName("VSegmentedControl")
    }
}

private struct VSegmentedControlPreviewWrapper: View {
    @State private var selection = 1

    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            VSegmentedControl(items: ["Profile", "Settings", "Channels", "Overview"], selection: $selection)
        }
    }
}
#endif
