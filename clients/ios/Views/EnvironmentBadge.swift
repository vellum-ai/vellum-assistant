#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// A small pill badge that displays the current environment and app version
/// on setup/onboarding screens for non-production builds.
///
/// Hidden entirely when the environment is `.production` (i.e. `displayLabel` is `nil`).
struct EnvironmentBadge: View {
    private let environment = VellumEnvironment.current

    private var appVersion: String? {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
    }

    var body: some View {
        if let envLabel = environment.displayLabel {
            HStack(spacing: VSpacing.xs) {
                Circle()
                    .fill(badgeColor)
                    .frame(width: 6, height: 6)

                Text(badgeText(envLabel: envLabel))
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.xs)
            .background(VColor.surfaceBase.opacity(0.9))
            .cornerRadius(VRadius.md)
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.borderBase, lineWidth: 1)
            )
            .padding(.top, VSpacing.md)
        }
    }

    private func badgeText(envLabel: String) -> String {
        if let version = appVersion {
            return "\(envLabel) \u{2022} v\(version)"
        }
        return envLabel
    }

    private var badgeColor: Color {
        switch environment {
        case .local:
            return .orange
        case .dev:
            return .blue
        case .test:
            return .purple
        case .staging:
            return .yellow
        case .production:
            return .green
        }
    }
}
#endif
