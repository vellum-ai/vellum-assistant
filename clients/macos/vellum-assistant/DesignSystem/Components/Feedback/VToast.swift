import SwiftUI

struct VToast: View {
    enum Style { case info, success, warning, error }

    let message: String
    var style: Style = .info
    var body: some View {
        HStack(spacing: VSpacing.md) {
            Image(systemName: iconName)
                .foregroundColor(iconColor)
            Text(message)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
        }
        .padding(.horizontal, VSpacing.xl)
        .padding(.vertical, VSpacing.lg)
        .background(VColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.3), radius: 8, y: 4)
    }

    private var iconName: String {
        switch style {
        case .info: return "info.circle.fill"
        case .success: return "checkmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .error: return "xmark.circle.fill"
        }
    }

    private var iconColor: Color {
        switch style {
        case .info: return VColor.accent
        case .success: return VColor.success
        case .warning: return VColor.warning
        case .error: return VColor.error
        }
    }
}
