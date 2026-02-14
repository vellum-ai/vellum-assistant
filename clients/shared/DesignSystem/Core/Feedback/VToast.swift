import SwiftUI
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

public struct VToast: View {
    public enum Style { case info, success, warning, error }

    public let message: String
    public var style: Style = .info

    public init(message: String, style: Style = .info) {
        self.message = message
        self.style = style
    }

    public var body: some View {
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
            #if os(macOS)
            NSAccessibility.post(
                element: NSApp as Any,
                notification: .announcementRequested,
                userInfo: [.announcement: message as NSString]
            )
            #elseif os(iOS)
            UIAccessibility.post(notification: .announcement, argument: message)
            #endif
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
