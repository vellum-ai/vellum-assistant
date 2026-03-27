import SwiftUI
import VellumAssistantShared

/// Shown immediately when the app's configured platform URL does not match the
/// lockfile assistant's runtime URL. Tells the user to open Settings and
/// reconfigure, or report the issue.
struct PlatformURLMismatchView: View {
    let configuredURL: String
    let lockfileURL: String
    let onOpenSettings: () -> Void
    let onSendLogs: () -> Void

    @State private var visible = false

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()

            VIconView(.triangleAlert, size: 28)
                .foregroundStyle(VColor.systemNegativeHover)

            VStack(spacing: VSpacing.sm) {
                Text("Platform URL mismatch")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundStyle(VColor.contentDefault)

                Text("The app is configured for **\(configuredURL)** but your assistant was created on **\(lockfileURL)**.")
                    .font(.system(size: 14))
                    .foregroundStyle(VColor.contentSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 380)
            }

            VButton(label: "Open Settings", leftIcon: VIcon.settings.rawValue, style: .outlined) {
                onOpenSettings()
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
