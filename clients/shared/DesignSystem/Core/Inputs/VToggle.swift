import SwiftUI

public struct VToggle: View {
    @Binding public var isOn: Bool
    public var label: String? = nil
    public var helperText: String? = nil
    @Environment(\.isEnabled) private var isEnabled

    private let trackWidth: CGFloat = 36
    private let trackHeight: CGFloat = 24
    private let knobSize: CGFloat = 18
    private let knobPadding: CGFloat = 3

    public init(isOn: Binding<Bool>, label: String? = nil, helperText: String? = nil) {
        self._isOn = isOn
        self.label = label
        self.helperText = helperText
    }

    public var body: some View {
        HStack(alignment: helperText != nil ? .top : .center, spacing: 10) {
            toggleTrack
                .padding(.top, helperText != nil ? 2 : 0)

            if label != nil || helperText != nil {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    if let label {
                        Text(label)
                            .font(VFont.bodyBold)
                            .foregroundColor(isEnabled ? VColor.textPrimary : VColor.textMuted)
                    }
                    if let helperText {
                        Text(helperText)
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                }
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
                .fill(trackColor)
                .frame(width: trackWidth, height: trackHeight)

            // Knob
            Circle()
                .fill(knobColor)
                .frame(width: knobSize, height: knobSize)
                .shadow(color: Color.black.opacity(0.08), radius: 2, x: 0, y: 1)
                .padding(.horizontal, knobPadding)
        }
    }

    private var trackColor: Color {
        if !isEnabled {
            return isOn ? VColor.toggleOn.opacity(0.5) : VColor.toggleOff
        }
        return isOn ? VColor.toggleOn : VColor.toggleOff
    }

    private var knobColor: Color {
        if !isEnabled {
            return VColor.toggleKnobDisabled
        }
        return VColor.toggleKnob
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
