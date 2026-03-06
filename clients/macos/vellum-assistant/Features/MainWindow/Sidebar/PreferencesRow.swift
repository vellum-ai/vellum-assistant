import SwiftUI
import VellumAssistantShared

struct PreferencesRow: View {
    let isActive: Bool
    let isExpanded: Bool
    let onToggle: () -> Void

    var body: some View {
        SidebarPrimaryRow(
            icon: "slider.horizontal.3",
            label: "Preferences",
            isActive: isActive,
            trailingIcon: isActive ? "chevron.down" : "chevron.up",
            isExpanded: isExpanded,
            action: onToggle
        )
    }
}
