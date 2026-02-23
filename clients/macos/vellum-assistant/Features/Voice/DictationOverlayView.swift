import SwiftUI
import VellumAssistantShared

enum DictationState {
    case recording
    case processing
    case done
    case error(String)
}

struct DictationOverlayView: View {
    let state: DictationState

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            stateIcon
            stateText
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .background(VColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .vShadow(.md)
    }

    @ViewBuilder
    private var stateIcon: some View {
        switch state {
        case .recording:
            Circle()
                .fill(Color.red)
                .frame(width: 8, height: 8)
        case .processing:
            VLoadingIndicator()
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(VColor.success)
        case .error:
            Image(systemName: "exclamation.triangle.fill")
                .foregroundStyle(VColor.error)
        }
    }

    @ViewBuilder
    private var stateText: some View {
        switch state {
        case .recording:
            Text("Recording...")
                .font(VFont.caption)
                .foregroundStyle(VColor.textSecondary)
        case .processing:
            Text("Processing...")
                .font(VFont.caption)
                .foregroundStyle(VColor.textSecondary)
        case .done:
            Text("Done")
                .font(VFont.caption)
                .foregroundStyle(VColor.success)
        case .error(let message):
            Text(message)
                .font(VFont.caption)
                .foregroundStyle(VColor.error)
        }
    }
}
