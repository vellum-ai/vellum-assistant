import SwiftUI

/// A compact, subtle status indicator that appears at the top of the active
/// chat view when the thread is not idle. Shows a colored dot + label
/// reflecting the current `ThreadInteractionState`.
///
/// Hidden when the state is `.idle` — slides in/out with `VAnimation.fast`.
public struct ThreadStatusBar: View {
    public let state: ThreadInteractionState

    public init(state: ThreadInteractionState) {
        self.state = state
    }

    public var body: some View {
        if state != .idle {
            HStack(spacing: VSpacing.xs) {
                Circle()
                    .fill(dotColor)
                    .frame(width: 6, height: 6)

                Text(label)
                    .font(VFont.caption)
                    .foregroundColor(labelColor)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(height: 24)
            .padding(.horizontal, VSpacing.md)
            .background(backgroundColor)
            .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }

    // MARK: - Private

    private var dotColor: Color {
        switch state {
        case .processing:
            return VColor.accent
        case .waitingForInput:
            return VColor.warning
        case .error:
            return VColor.error
        case .idle:
            return .clear
        }
    }

    private var labelColor: Color {
        switch state {
        case .processing:
            return VColor.textSecondary
        case .waitingForInput:
            return VColor.warning
        case .error:
            return VColor.error
        case .idle:
            return .clear
        }
    }

    private var label: String {
        switch state {
        case .processing:
            return "Processing..."
        case .waitingForInput:
            return "Waiting for input"
        case .error:
            return "Error"
        case .idle:
            return ""
        }
    }

    private var backgroundColor: Color {
        switch state {
        case .processing:
            return VColor.accent.opacity(0.06)
        case .waitingForInput:
            return VColor.warning.opacity(0.06)
        case .error:
            return VColor.error.opacity(0.06)
        case .idle:
            return .clear
        }
    }
}
