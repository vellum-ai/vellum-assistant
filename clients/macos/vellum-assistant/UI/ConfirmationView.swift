import SwiftUI

struct ConfirmationView: View {
    let reason: String
    let onAllow: () -> Void
    let onBlock: () -> Void
    let onStop: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VellumSpacing.lg) {
            HStack(spacing: VellumSpacing.md) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.title2)
                    .foregroundStyle(VellumTheme.warning)
                Text("Action Requires Confirmation")
                    .font(VellumFont.heading)
            }

            Text(reason)
                .font(VellumFont.body)
                .foregroundStyle(.secondary)

            HStack(spacing: VellumSpacing.lg) {
                Spacer()
                Button("Stop Session") {
                    onStop()
                }
                .buttonStyle(.bordered)
                .tint(.red)

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
