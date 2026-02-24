#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Sheet presented when the Ride Shotgun timer fires, asking the user whether
/// to let the assistant watch and learn from what they are doing on their Mac.
struct RideShotgunInvitationSheet: View {
    let onAccept: () -> Void
    let onDecline: () -> Void

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            Image(systemName: "binoculars.fill")
                .font(.system(size: 48))
                .foregroundStyle(VColor.accent)
                .accessibilityHidden(true)

            VStack(spacing: VSpacing.sm) {
                Text("Ride Shotgun")
                    .font(VFont.title)
                    .foregroundStyle(VColor.textPrimary)

                Text("Let me watch your Mac briefly to learn how you work — I'll pick up patterns in your workflow and spot where I can save you time.")
                    .font(VFont.body)
                    .foregroundStyle(VColor.textSecondary)
                    .multilineTextAlignment(.center)
            }

            VStack(spacing: VSpacing.sm) {
                bulletRow(icon: "waveform.path.ecg", text: "Pick up patterns in your workflow")
                bulletRow(icon: "clock.badge.checkmark", text: "Spot where I can save you time")
                bulletRow(icon: "lightbulb.fill", text: "Get context so my suggestions are relevant")
            }
            .padding(.vertical, VSpacing.sm)

            VStack(spacing: VSpacing.sm) {
                Button {
                    onAccept()
                } label: {
                    Text("Yes, ride shotgun")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(VColor.accent)
                .accessibilityLabel("Accept ride shotgun invitation")

                Button {
                    onDecline()
                } label: {
                    Text("Not now")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Decline ride shotgun invitation")
            }
        }
        .padding(VSpacing.xl)
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }

    private func bulletRow(icon: String, text: String) -> some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: icon)
                .foregroundStyle(VColor.accent)
                .frame(width: 20)
                .accessibilityHidden(true)
            Text(text)
                .font(VFont.body)
                .foregroundStyle(VColor.textSecondary)
            Spacer()
        }
    }
}

#Preview {
    Color.clear
        .sheet(isPresented: .constant(true)) {
            RideShotgunInvitationSheet(onAccept: {}, onDecline: {})
        }
}
#endif
