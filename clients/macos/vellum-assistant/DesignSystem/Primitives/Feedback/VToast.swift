import SwiftUI
import AppKit

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
        .vShadow(VShadow.md)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("\(String(describing: style)): \(message)"))
        .onAppear {
            NSAccessibility.post(
                element: NSApp as Any,
                notification: .announcementRequested,
                userInfo: [
                    .announcement: "\(style): \(message)" as NSString,
                    .priority: NSAccessibilityPriorityLevel.high.rawValue
                ]
            )
        }
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

#Preview("VToast") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: 12) {
            VToast(message: "Information message", style: .info)
            VToast(message: "Success message", style: .success)
            VToast(message: "Warning message", style: .warning)
            VToast(message: "Error message", style: .error)
        }
        .padding()
    }
    .frame(width: 400, height: 300)
}
