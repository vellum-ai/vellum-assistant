import SwiftUI

public struct VToggle: View {
    @Binding public var isOn: Bool
    public var label: String? = nil

    public init(isOn: Binding<Bool>, label: String? = nil) {
        self._isOn = isOn
        self.label = label
    }

    // MARK: - Layout Constants

    private let trackWidth: CGFloat = 50
    private let trackHeight: CGFloat = 28
    private let knobSize: CGFloat = 22
    private let knobPadding: CGFloat = 3

    public var body: some View {
        HStack(spacing: VSpacing.sm) {
            toggleTrack

            if let label = label {
                Text(label)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            withAnimation(VAnimation.fast) {
                isOn.toggle()
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
            RoundedRectangle(cornerRadius: trackHeight / 2)
                .fill(isOn ? Forest._600 : VColor.toggleOff)
                .frame(width: trackWidth, height: trackHeight)

            // Knob
            RoundedRectangle(cornerRadius: knobSize / 2)
                .fill(Color.white)
                .frame(width: knobSize, height: knobSize)
                .shadow(color: Color.black.opacity(0.15), radius: 3, x: 0, y: 1)
                .padding(.horizontal, knobPadding)
        }
    }
}

#if DEBUG
struct VToggle_Preview: PreviewProvider {
    static var previews: some View {
        VTogglePreviewWrapper()
            .frame(width: 300, height: 200)
            .previewDisplayName("VToggle")
    }
}

private struct VTogglePreviewWrapper: View {
    @State private var isOnA = true
    @State private var isOnB = false

    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 16) {
                VToggle(isOn: $isOnA, label: "Enabled toggle")
                VToggle(isOn: $isOnB, label: "Disabled toggle")
                VToggle(isOn: $isOnA)
            }
            .padding()
        }
    }
}
#endif
