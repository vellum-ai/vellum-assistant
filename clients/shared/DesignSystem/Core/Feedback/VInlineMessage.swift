import SwiftUI

/// Compact inline feedback banner for form-level status and error messaging.
public struct VInlineMessage: View {
    public enum Tone {
        case info
        case success
        case warning
        case error
    }

    public let message: String
    public var tone: Tone

    public init(_ message: String, tone: Tone = .error) {
        self.message = message
        self.tone = tone
    }

    public var body: some View {
        HStack(alignment: .top, spacing: VSpacing.xs) {
            VIconView(icon, size: 12)
                .foregroundColor(foregroundColor)
                .padding(.top, 1)
                .accessibilityHidden(true)

            Text(message)
                .font(VFont.labelDefault)
                .foregroundColor(foregroundColor)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(backgroundColor)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(borderColor, lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }

    private var icon: VIcon {
        switch tone {
        case .info:
            return .info
        case .success:
            return .circleCheck
        case .warning, .error:
            return .triangleAlert
        }
    }

    private var foregroundColor: Color {
        switch tone {
        case .info:
            return VColor.primaryBase
        case .success:
            return VColor.systemPositiveStrong
        case .warning:
            return VColor.systemMidStrong
        case .error:
            return VColor.systemNegativeStrong
        }
    }

    private var backgroundColor: Color {
        switch tone {
        case .info:
            return VColor.primaryBase.opacity(0.10)
        case .success:
            return VColor.systemPositiveWeak
        case .warning:
            return VColor.systemMidWeak
        case .error:
            return VColor.systemNegativeWeak
        }
    }

    private var borderColor: Color {
        switch tone {
        case .info:
            return VColor.primaryBase.opacity(0.18)
        case .success:
            return VColor.systemPositiveStrong.opacity(0.14)
        case .warning:
            return VColor.systemMidStrong.opacity(0.16)
        case .error:
            return VColor.systemNegativeStrong.opacity(0.16)
        }
    }
}
