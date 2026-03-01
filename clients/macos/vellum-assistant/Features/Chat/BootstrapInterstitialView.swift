import SwiftUI
import VellumAssistantShared

/// Blocking interstitial shown during first-launch bootstrap when the daemon
/// takes longer than expected to become ready. Displays a loading indicator,
/// status message, and a manual retry button. The interstitial prevents the
/// user from seeing the empty chat state while the daemon is starting.
struct BootstrapInterstitialView: View {
    /// Optional error message to display (replaces the default "starting" text).
    var errorMessage: String?

    /// Whether a retry/connection attempt is currently in progress.
    var isRetrying: Bool = false

    /// Called when the user taps the manual "Try Again" button.
    var onRetry: () -> Void = {}

    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()

            VStack(spacing: VSpacing.xl) {
                VLoadingIndicator(size: 32, color: VColor.accent)
                    .opacity(isRetrying ? 1 : 0.6)

                Text(errorMessage ?? "Still starting your assistant...")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)

                VButton(
                    label: "Try Again",
                    icon: "arrow.clockwise",
                    style: .tertiary,
                    size: .medium,
                    isDisabled: isRetrying
                ) {
                    onRetry()
                }
            }
            .padding(VSpacing.xxl)
            .background(
                RoundedRectangle(cornerRadius: VRadius.xl)
                    .fill(VColor.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.xl)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
            )
            .frame(maxWidth: 320)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

#Preview("BootstrapInterstitialView - Loading") {
    ZStack {
        VColor.background.ignoresSafeArea()
        BootstrapInterstitialView(isRetrying: true)
    }
    .frame(width: 500, height: 400)
}

#Preview("BootstrapInterstitialView - Error") {
    ZStack {
        VColor.background.ignoresSafeArea()
        BootstrapInterstitialView(
            errorMessage: "Could not connect after 5 attempts. Please try again.",
            isRetrying: false
        )
    }
    .frame(width: 500, height: 400)
}
