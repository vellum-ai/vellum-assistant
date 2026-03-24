import VellumAssistantShared
import SwiftUI

struct ConfirmationView: View {
    let reason: String
    let onAllow: () -> Void
    let onBlock: () -> Void
    let onStop: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            HStack(spacing: VSpacing.md) {
                VIconView(.triangleAlert, size: 20)
                    .foregroundStyle(VColor.systemNegativeHover)
                Text("Action Requires Confirmation")
                    .font(VFont.bodySmallEmphasised)
            }

            Text(reason)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)

            HStack(spacing: VSpacing.lg) {
                Spacer()
                Button("Stop Session") {
                    onStop()
                }
                .buttonStyle(.bordered)
                .tint(VColor.systemNegativeStrong)

                Button("Block") {
                    onBlock()
                }
                .buttonStyle(.bordered)

                Button("Allow") {
                    onAllow()
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .frame(width: 400)
    }
}
