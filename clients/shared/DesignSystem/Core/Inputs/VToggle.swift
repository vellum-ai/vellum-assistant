import SwiftUI

public struct VToggle: View {
    @Binding public var isOn: Bool
    public var label: String? = nil
    public var helperText: String? = nil
    public var interactive: Bool
    @Environment(\.isEnabled) private var isEnabled

    private let trackWidth: CGFloat = 36
    private let trackHeight: CGFloat = 24
    private let knobSize: CGFloat = 20
    private let knobPadding: CGFloat = 2

    public init(isOn: Binding<Bool>, label: String? = nil, helperText: String? = nil, interactive: Bool = true) {
        self._isOn = isOn
        self.label = label
        self.helperText = helperText
        self.interactive = interactive
    }

    public var body: some View {
        content
            .accessibilityElement(children: interactive ? .combine : .ignore)
            .accessibilityAddTraits(interactive ? .isButton : [])
            .accessibilityValue(isOn ? "On" : "Off")
            .accessibilityLabel(label ?? "Toggle")
    }

    private var content: some View {
        Group {
            if interactive {
                rowContent
                    .contentShape(Rectangle())
                    .onTapGesture {
                        guard isEnabled else { return }
                        withAnimation(VAnimation.fast) {
                            isOn.toggle()
                        }
                    }
                    .pointerCursor()
            } else {
                rowContent
            }
        }
    }

    private var rowContent: some View {
        HStack(alignment: helperText != nil ? .top : .center, spacing: 10) {
            toggleTrack
                .padding(.top, helperText != nil ? 2 : 0)

            if label != nil || helperText != nil {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    if let label {
                        Text(label)
                            .font(VFont.bodyMedium)
                            .foregroundColor(isEnabled ? VColor.contentDefault : VColor.contentDisabled)
                    }
                    if let helperText {
                        Text(helperText)
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                    }
                }
                Spacer(minLength: 0)
            }
        }
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
                .shadow(color: VColor.auxBlack.opacity(0.08), radius: 2, x: 0, y: 1)
                .padding(.horizontal, knobPadding)
        }
    }

    private var trackColor: Color {
        if !isEnabled {
            return VColor.surfaceBase
        }
        return isOn ? VColor.primaryActive : VColor.surfaceBase
    }

    private var knobColor: Color {
        if !isEnabled {
            return VColor.surfaceOverlay
        }
        return VColor.auxWhite
    }
}
