import SwiftUI
import VellumAssistantShared

/// SwiftUI content for the pairing approval prompt.
/// Shows the device name and three action buttons: Deny, Approve Once, Always Allow.
struct PairingApprovalView: View {
    let deviceName: String
    let onDecision: (String) -> Void

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            VIconView(.smartphone, size: 40)
                .foregroundStyle(VColor.contentSecondary)

            Text("Pairing Request")
                .font(VFont.headline)

            Text("\"\(deviceName)\" wants to pair with your Mac.")
                .font(VFont.body)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: VSpacing.md) {
                Button("Deny") {
                    onDecision("deny")
                }
                .keyboardShortcut(.cancelAction)

                Button("Approve Once") {
                    onDecision("approve_once")
                }

                Button("Always Allow") {
                    onDecision("always_allow")
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(VSpacing.xl)
        .frame(minWidth: 340)
    }
}
