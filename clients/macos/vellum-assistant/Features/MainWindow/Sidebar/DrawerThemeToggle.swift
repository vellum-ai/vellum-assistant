import SwiftUI
import VellumAssistantShared

/// Compact three-way theme toggle (System / Light / Dark) for the control center drawer.
/// Thin wrapper around the shared `VThemeToggle` component.
struct DrawerThemeToggle: View {
    var body: some View {
        VThemeToggle()
    }
}
