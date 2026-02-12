import SwiftUI

struct ConfirmationView: View {
    let reason: String
    let onAllow: () -> Void
    let onBlock: () -> Void
    let onStop: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            HStack(spacing: VSpacing.md) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.title2)
                    .foregroundStyle(VColor.warning)
                Text("Action Requires Confirmation")
                    .font(VFont.headline)
            }

            Text(reason)
                .font(VFont.body)
                .foregroundStyle(.secondary)

            HStack(spacing: VSpacing.lg) {
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

#Preview {
    ConfirmationView(
        reason: "This action will press Cmd+Delete which may delete files.",
        onAllow: {},
        onBlock: {},
        onStop: {}
    )
}
