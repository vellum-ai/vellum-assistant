import SwiftUI
import VellumAssistantShared

/// Small pill in the toolbar showing the current push-to-talk activation key.
/// Hidden when PTT is disabled (activationKey == "none").
/// Tapping navigates to the Voice settings tab.
struct PTTKeyIndicator: View {
    /// Watches the raw `activationKey` default to trigger SwiftUI refreshes.
    @AppStorage("activationKey") private var activationKey: String = "fn"

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
            VShortcutTag(keyName, icon: VIcon.mic.rawValue) {
                onTap()
            }
        }
    }
}
