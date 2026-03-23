import SwiftUI
import VellumAssistantShared

/// SwiftUI content for an ACP agent permission prompt.
/// Shows the tool details and action buttons derived from the ACP options.
struct AcpPermissionView: View {
    let toolTitle: String
    let toolKind: String
    let rawInput: String?
    let options: [AcpPermissionRequestMessage.Option]
    let onDecision: (String) -> Void

    var body: some View {
        VStack(spacing: 16) {
            VIconView(.shieldCheck, size: 40)
                .foregroundColor(.secondary)

            Text("Agent Permission Request")
                .font(.headline)

            Text("An ACP agent wants to use: **\(toolTitle)**")
                .font(.body)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            if let rawInput, !rawInput.isEmpty {
                ScrollView {
                    Text(rawInput)
                        .font(.system(.caption, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                .frame(maxHeight: 120)
                .background(Color(nsColor: .controlBackgroundColor))
                .cornerRadius(6)
            }

            HStack(spacing: 12) {
                // Render reject options first, then allow options
                ForEach(rejectOptions, id: \.optionId) { option in
                    Button(option.name) {
                        onDecision(option.optionId)
                    }
                    .keyboardShortcut(.cancelAction)
                }

                ForEach(allowOptions, id: \.optionId) { option in
                    let isDefault = option.kind == "allow_always" || (allowOptions.count == 1)
                    Button(option.name) {
                        onDecision(option.optionId)
                    }
                    .keyboardShortcut(isDefault ? .defaultAction : .none)
                }
            }
        }
        .padding(24)
        .frame(minWidth: 400)
    }

    private var rejectOptions: [AcpPermissionRequestMessage.Option] {
        options.filter { $0.kind.hasPrefix("reject") }
    }

    private var allowOptions: [AcpPermissionRequestMessage.Option] {
        options.filter { $0.kind.hasPrefix("allow") }
    }
}
