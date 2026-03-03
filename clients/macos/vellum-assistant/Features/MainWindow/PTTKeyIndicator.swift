import SwiftUI
import VellumAssistantShared

/// Small pill in the toolbar showing the current push-to-talk activation key.
/// Hidden when PTT is disabled (activationKey == "none").
/// Tapping navigates to the Voice/Wake Word settings tab.
struct PTTKeyIndicator: View {
    /// Watches the raw `activationKey` default to trigger SwiftUI refreshes.
    @AppStorage("activationKey") private var activationKey: String = "fn"
    @State private var isHovered = false

    let onTap: () -> Void

    private var activator: PTTActivator {
        PTTActivator.fromStored()
    }

    private var displayName: String? {
        let current = activator
        guard current.kind != .none else { return nil }
        return current.displayName
    }

    var body: some View {
        if let keyName = displayName {
            Button(action: onTap) {
                HStack(spacing: 4) {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 9))
                    Text(keyName)
                        .font(VFont.caption)
                }
                .foregroundColor(isHovered ? VColor.textPrimary : VColor.textSecondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(
                    Capsule()
                        .fill(isHovered ? VColor.surfaceSubtle.opacity(0.8) : VColor.surfaceSubtle)
                )
                .overlay(
                    Capsule()
                        .strokeBorder(VColor.surfaceBorder, lineWidth: 0.5)
                )
            }
            .buttonStyle(.plain)
            .onHover { hovering in
                isHovered = hovering
            }
            .help("Push-to-talk: hold \(keyName)")
        }
    }
}
