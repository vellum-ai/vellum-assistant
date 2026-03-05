import SwiftUI
import VellumAssistantShared

struct PreferencesRow: View {
    let onToggle: () -> Void

    var body: some View {
        VButton(
            label: "Preferences",
            leftIcon: "slider.horizontal.3",
            rightIcon: "chevron.up",
            style: .secondary,
            size: .medium,
            isFullWidth: true,
            action: onToggle
        )
        .padding(.horizontal, VSpacing.sm)
        .padding(.bottom, VSpacing.sm)
    }
}
