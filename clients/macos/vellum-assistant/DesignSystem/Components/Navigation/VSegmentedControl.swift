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
                            .padding(.vertical, VSpacing.md)

                        Rectangle()
                            .fill(selection == index ? VColor.accent : .clear)
                            .frame(height: 2)
                    }
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(items[index])
                .accessibilityAddTraits(selection == index ? .isSelected : [])
            }
        }
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
