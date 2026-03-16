import SwiftUI

/// Dismissible banner shown when a non-retryable conversation error occurs.
public struct ChatErrorBanner: View {
    public let message: String
    public var onDismiss: (() -> Void)?

    public init(message: String, onDismiss: (() -> Void)? = nil) {
        self.message = message
        self.onDismiss = onDismiss
    }

    public var body: some View {
        HStack(spacing: 8) {
            VIconView(.triangleAlert, size: 14)
                .foregroundStyle(VColor.systemNegativeHover)
            Text(message)
                .font(.footnote)
                .foregroundStyle(VColor.contentDefault)
            Spacer()
            if let onDismiss {
                Button(action: onDismiss) {
                    VIconView(.x, size: 14)
                        .foregroundStyle(VColor.contentSecondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(VColor.surfaceBase, in: RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal)
    }
}
