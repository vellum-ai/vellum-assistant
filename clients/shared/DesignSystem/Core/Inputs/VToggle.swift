import SwiftUI

public struct VToggle: View {
    @Binding public var isOn: Bool
    public var label: String? = nil
    public var size: Size = .large
    @Environment(\.isEnabled) private var isEnabled

    public enum Size {
        /// Original large size: track 50×28, knob 22×22, padding 3.
        case large
        /// Smaller variant for settings panels: track 40×22, knob 18×18, padding 2.
        case medium

        var trackWidth: CGFloat {
            switch self {
            case .large: return 50
            case .medium: return 40
            }
        }

        var trackHeight: CGFloat {
            switch self {
            case .large: return 28
            case .medium: return 22
            }
        }

        var knobSize: CGFloat {
            switch self {
            case .large: return 22
            case .medium: return 18
            }
        }

        var knobPadding: CGFloat {
            switch self {
            case .large: return 3
            case .medium: return 2
            }
        }
    }

    public init(isOn: Binding<Bool>, label: String? = nil, size: Size = .large) {
        self._isOn = isOn
        self.label = label
        self.size = size
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
            RoundedRectangle(cornerRadius: size.trackHeight / 2)
                .fill(isOn ? Forest._600 : VColor.toggleOff)
                .frame(width: size.trackWidth, height: size.trackHeight)

            // Knob
            RoundedRectangle(cornerRadius: size.knobSize / 2)
                .fill(Color.white)
                .frame(width: size.knobSize, height: size.knobSize)
                .shadow(color: Color.black.opacity(0.15), radius: 3, x: 0, y: 1)
                .padding(.horizontal, size.knobPadding)
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
                VToggle(isOn: $isOnA, label: "Large toggle", size: .large)
            }
            .padding()
        }
    }
}
#endif
