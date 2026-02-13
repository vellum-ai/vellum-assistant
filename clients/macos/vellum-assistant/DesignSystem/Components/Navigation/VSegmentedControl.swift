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
                    .fixedSize(horizontal: true, vertical: false)
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
#Preview("VSegmentedControl") {
    @Previewable @State var selection = 1
    ZStack {
        VColor.background.ignoresSafeArea()
        VSegmentedControl(items: ["Profile", "Settings", "Channels", "Overview"], selection: $selection)
    }
    .frame(width: 500, height: 60)
}
#endif
