import SwiftUI

struct VToggle: View {
    @Binding var isOn: Bool
    var label: String? = nil

    // MARK: - Layout Constants

    private let trackWidth: CGFloat = 40
    private let trackHeight: CGFloat = 22
    private let knobSize: CGFloat = 16
    private let knobPadding: CGFloat = 3

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            toggleTrack

            if let label = label {
                Text(label)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(isOn ? "On" : "Off")
        .accessibilityLabel(label ?? "Toggle")
    }

    // MARK: - Track

    private var toggleTrack: some View {
        ZStack(alignment: isOn ? .trailing : .leading) {
            // Track background
            RoundedRectangle(cornerRadius: VRadius.pill)
                .fill(isOn ? Emerald._500 : Slate._700)
                .frame(width: trackWidth, height: trackHeight)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.pill)
                        .stroke(Slate._600, lineWidth: 1)
                )

            // Knob
            Circle()
                .fill(Color.white)
                .frame(width: knobSize, height: knobSize)
                .padding(.horizontal, knobPadding)
        }
        .onTapGesture {
            withAnimation(VAnimation.fast) {
                isOn.toggle()
            }
        }
    }
}

#if DEBUG
#Preview("VToggle") {
    @Previewable @State var isOnA = true
    @Previewable @State var isOnB = false
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(alignment: .leading, spacing: 16) {
            VToggle(isOn: $isOnA, label: "Enabled toggle")
            VToggle(isOn: $isOnB, label: "Disabled toggle")
            VToggle(isOn: $isOnA)
        }
        .padding()
    }
    .frame(width: 300, height: 200)
}
#endif
