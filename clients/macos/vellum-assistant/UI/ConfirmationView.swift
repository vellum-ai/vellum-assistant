import SwiftUI

struct ConfirmationView: View {
    let reason: String
    let onAllow: () -> Void
    let onBlock: () -> Void
    let onStop: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.title2)
                    .foregroundStyle(.yellow)
                Text("Action Requires Confirmation")
                    .font(.headline)
            }

            Text(reason)
                .font(.body)
                .foregroundStyle(.secondary)

            HStack(spacing: 12) {
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
