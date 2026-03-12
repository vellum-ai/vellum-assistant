import SwiftUI
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

public struct VToastAction {
    public let label: String
    public let action: () -> Void

    public init(label: String, action: @escaping () -> Void) {
        self.label = label
        self.action = action
    }
}

public struct VToast: View {
    public enum Style { case info, success, warning, error }

    public let message: String
    public var style: Style = .info
    public var primaryAction: VToastAction?
    public var secondaryAction: VToastAction?
    public var onDismiss: (() -> Void)?

    public init(
        message: String,
        style: Style = .info,
        primaryAction: VToastAction? = nil,
        secondaryAction: VToastAction? = nil,
        onDismiss: (() -> Void)? = nil
    ) {
        self.message = message
        self.style = style
        self.primaryAction = primaryAction
        self.secondaryAction = secondaryAction
        self.onDismiss = onDismiss
    }

    public var body: some View {
        HStack(spacing: VSpacing.md) {
            VIconView(vIcon, size: 14)
                .foregroundColor(iconColor)
            Text(message)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
                .lineLimit(3)

            Spacer(minLength: 0)

            if primaryAction != nil || secondaryAction != nil || onDismiss != nil {
                HStack(spacing: VSpacing.sm) {
                    if let secondary = secondaryAction {
                        VButton(label: secondary.label, style: .tertiary, action: secondary.action)
                    }
                    if let primary = primaryAction {
                        VButton(label: primary.label, style: actionButtonStyle, action: primary.action)
                    }
                    if let onDismiss {
                        Button(action: onDismiss) {
                            VIconView(.x, size: 12)
                                .foregroundColor(VColor.contentSecondary)
                                .frame(width: 24, height: 24)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Dismiss")
                    }
                }
            }
        }
        .padding(.horizontal, VSpacing.xl)
        .padding(.vertical, VSpacing.lg)
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(accentBorder, lineWidth: 1)
        )
        .vShadow(VShadow.md)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("\(String(describing: style)): \(message)"))
        .onAppear {
            #if os(macOS)
            NSAccessibility.post(
                element: NSApp as Any,
                notification: .announcementRequested,
                userInfo: [
                    .announcement: "\(style): \(message)" as NSString,
                    .priority: NSAccessibilityPriorityLevel.high.rawValue
                ]
            )
            #elseif os(iOS)
            UIAccessibility.post(notification: .announcement, argument: "\(style): \(message)")
            #endif
        }
    }

    /// Use danger style for error toasts, primary for everything else.
    private var actionButtonStyle: VButton.Style {
        style == .error ? .danger : .primary
    }

    /// Border color tinted by toast style for visual emphasis.
    private var accentBorder: Color {
        switch style {
        case .error: return VColor.systemNegativeStrong.opacity(0.4)
        case .warning: return VColor.systemNegativeHover.opacity(0.4)
        default: return VColor.borderBase
        }
    }

    private var vIcon: VIcon {
        switch style {
        case .info: return .info
        case .success: return .circleCheck
        case .warning: return .triangleAlert
        case .error: return .circleX
        }
    }

    private var iconColor: Color {
        switch style {
        case .info: return VColor.primaryBase
        case .success: return VColor.systemPositiveStrong
        case .warning: return VColor.systemNegativeHover
        case .error: return VColor.systemNegativeStrong
        }
    }
}

#Preview("VToast") {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
        VStack(spacing: 12) {
            VToast(message: "Information message", style: .info)
            VToast(message: "Success message", style: .success)
            VToast(message: "Warning message", style: .warning)
            VToast(message: "Error message", style: .error)
            VToast(
                message: "Error with actions",
                style: .error,
                primaryAction: VToastAction(label: "Retry") {},
                secondaryAction: VToastAction(label: "Copy Debug Info") {},
                onDismiss: {}
            )
        }
        .padding()
    }
    .frame(width: 500, height: 400)
}
