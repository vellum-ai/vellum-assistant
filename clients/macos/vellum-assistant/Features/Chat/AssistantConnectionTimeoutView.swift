import SwiftUI
import VellumAssistantShared

/// Shown when the assistant loading skeleton times out without connecting.
/// Displays an "unreachable" message with actions to retry or report to Vellum.
struct AssistantConnectionTimeoutView: View {
    let onRetry: () -> Void
    let onSendLogs: () -> Void

    @State private var visible = false

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()

            VIconView(.triangleAlert, size: 28)
                .foregroundColor(VColor.systemNegativeHover)

            VStack(spacing: VSpacing.sm) {
                Text("Your assistant is unreachable")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundColor(VColor.contentDefault)

                Text("We couldn\u{2019}t connect to your assistant. Please try again.")
                    .font(.system(size: 14))
                    .foregroundColor(VColor.contentSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 380)
            }

            VButton(label: "Retry", leftIcon: VIcon.refreshCw.rawValue, style: .outlined) {
                onRetry()
            }

            VButton(label: "Report to Vellum", leftIcon: VIcon.send.rawValue, style: .ghost) {
                onSendLogs()
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .opacity(visible ? 1 : 0)
        .onAppear {
            withAnimation(VAnimation.standard) {
                visible = true
            }
        }
    }
}
