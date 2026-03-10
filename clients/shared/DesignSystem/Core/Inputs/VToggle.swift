import SwiftUI

public struct VToggle: View {
    @Binding public var isOn: Bool
    public var label: String? = nil
    @Environment(\.isEnabled) private var isEnabled

    private let trackWidth: CGFloat = 34
    private let trackHeight: CGFloat = 18
    private let knobSize: CGFloat = 14
    private let knobPadding: CGFloat = 2

    public init(isOn: Binding<Bool>, label: String? = nil) {
        self._isOn = isOn
        self.label = label
    }

    public var body: some View {
        HStack(spacing: VSpacing.sm) {
            toggleTrack

            if let label = label {
                Text(label)
                    .font(VFont.body)
                    .foregroundColor(isEnabled ? VColor.textPrimary : VColor.textMuted)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            guard isEnabled else { return }
            withAnimation(VAnimation.fast) {
                isOn.toggle()
            }
        }
        .pointerCursor()
        .opacity(isEnabled ? 1.0 : 0.5)
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
                .overlay(
                    RoundedRectangle(cornerRadius: trackHeight / 2)
                        .stroke(VColor.toggleBorder, lineWidth: 1)
                        .opacity(isOn ? 0 : 1)
                )

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
