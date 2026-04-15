#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// A small pill badge that displays the current environment and resolved
/// platform URL on setup/onboarding screens for non-production builds.
///
/// Hidden entirely when the environment is `.production` (i.e. `displayLabel` is `nil`).
struct EnvironmentBadge: View {
    private let environment = VellumEnvironment.current
    private let platformURL = VellumEnvironment.resolvedPlatformURL

    var body: some View {
        if let envLabel = environment.displayLabel {
            VStack(spacing: VSpacing.xxs) {
                HStack(spacing: VSpacing.xs) {
                    Circle()
                        .fill(badgeColor)
                        .frame(width: 6, height: 6)

                    Text(envLabel)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }

                Text(platformURL)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(VColor.contentTertiary)
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

    private var badgeColor: Color {
        switch environment {
        case .local:
            return VColor.funCoral
        case .dev:
            return VColor.funBlue
        case .test:
            return VColor.funPurple
        case .staging:
            return VColor.funYellow
        case .production:
            return VColor.funGreen
        }
    }
}
#endif
