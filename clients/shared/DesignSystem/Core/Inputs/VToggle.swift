import SwiftUI

public struct VToggle: View {
    @Binding public var isOn: Bool
    public var label: String? = nil

    public init(isOn: Binding<Bool>, label: String? = nil) {
        self._isOn = isOn
        self.label = label
    }

    // MARK: - Layout Constants

    private let trackWidth: CGFloat = 40
    private let trackHeight: CGFloat = 22
    private let knobSize: CGFloat = 16
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
            RoundedRectangle(cornerRadius: VRadius.sm + 2)
                .fill(isOn ? Emerald._500 : Slate._700)
                .frame(width: trackWidth, height: trackHeight)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm + 2)
                        .stroke(Slate._600, lineWidth: 1)
                )

            // Knob
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(Color.white)
                .frame(width: knobSize, height: knobSize)
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
