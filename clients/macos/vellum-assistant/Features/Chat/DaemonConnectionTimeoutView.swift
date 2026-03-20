import SwiftUI
import VellumAssistantShared

/// Shown when the daemon loading skeleton times out without connecting.
/// Displays an "unreachable" message with actions to retry, navigate to
/// the developer settings tab, or send logs.
struct DaemonConnectionTimeoutView: View {
    let onRetry: () -> Void
    let onGoToDeveloper: () -> Void
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

                Text("We couldn\u{2019}t connect to your assistant. Check your connection settings in the Developer tab or try again.")
                    .font(.system(size: 14))
                    .foregroundColor(VColor.contentSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 380)
            }

            HStack(spacing: VSpacing.md) {
                VButton(label: "Retry", leftIcon: VIcon.refreshCw.rawValue, style: .outlined) {
                    onRetry()
                }
                VButton(label: "Developer Settings", leftIcon: VIcon.settings.rawValue, style: .primary) {
                    onGoToDeveloper()
                }
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
