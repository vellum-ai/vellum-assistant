import VellumAssistantShared
import SwiftUI

@MainActor
struct APIKeyStepView: View {
    @Bindable var state: OnboardingState
    var isAuthenticated: Bool = false
    var onHatchManaged: (() -> Void)?

    @State private var showTitle = false
    @State private var showContent = false

    var body: some View {
        Text("Setup")
            .font(.system(size: 32, weight: .regular, design: .serif))
            .foregroundColor(VColor.contentDefault)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        Text("Choose how to run your assistant.")
            .font(.system(size: 16))
            .foregroundColor(VColor.contentSecondary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)

        Spacer()

        ScrollView {
            VStack(spacing: VSpacing.md) {
                hostingCards

                OnboardingButton(
                    title: continueButtonTitle,
                    style: .primary,
                    disabled: !canContinue
                ) {
                    handleContinue()
                }

                HStack(spacing: VSpacing.lg) {
                    Button(action: { goBack() }) {
                        Text("Back")
                            .font(.system(size: 13))
                            .foregroundColor(VColor.contentTertiary)
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()
                }
                .padding(.top, VSpacing.xs)
            }
            .padding(.horizontal, VSpacing.xxl)
            .padding(.bottom, VSpacing.lg)
        }
        .opacity(showContent ? 1 : 0)
        .offset(y: showContent ? 0 : 12)
        .onAppear {
            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                showContent = true
            }
        }
    }

    // MARK: - Hosting Cards

    private var hostingCards: some View {
        VStack(spacing: VSpacing.sm) {
            if !state.skippedAuth {
                hostingCard(
                    icon: .cloud,
                    title: "Vellum Cloud",
                    subtitle: "Hosted and managed by Vellum",
                    mode: .vellumCloud,
                    comingSoon: true
                )
            }

            hostingCard(
                icon: .laptop,
                title: "Local",
                subtitle: "Run on your machine",
                mode: .local,
                comingSoon: false
            )

            hostingCard(
                icon: .package,
                title: "Local Docker",
                subtitle: "Run in a Docker container",
                mode: .localDocker,
                comingSoon: true
            )

            hostingCard(
                icon: .globe,
                title: "VPS",
                subtitle: "Run on a virtual private server",
                mode: .vps,
                comingSoon: true
            )
        }
    }

    private func hostingCard(
        icon: VIcon,
        title: String,
        subtitle: String,
        mode: OnboardingState.HostingMode,
        comingSoon: Bool
    ) -> some View {
        let isSelected = state.selectedHostingMode == mode && !comingSoon

        return Button(action: {
            guard !comingSoon else { return }
            state.selectedHostingMode = mode
        }) {
            HStack(spacing: VSpacing.md) {
                VIconView(icon, size: 18)
                    .foregroundColor(comingSoon ? VColor.contentDisabled : (isSelected ? VColor.primaryBase : VColor.contentSecondary))

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(comingSoon ? VColor.contentDisabled : VColor.contentDefault)
                    Text(subtitle)
                        .font(.system(size: 12))
                        .foregroundColor(comingSoon ? VColor.contentDisabled : VColor.contentSecondary)
                }

                Spacer()

                if comingSoon {
                    Text("Coming Soon")
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.contentTertiary)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xxs)
                        .background(VColor.surfaceActive)
                        .clipShape(Capsule())
                } else {
                    Circle()
                        .fill(isSelected ? VColor.primaryBase : Color.clear)
                        .overlay(
                            Circle().stroke(isSelected ? VColor.primaryBase : VColor.borderBase, lineWidth: 1.5)
                        )
                        .overlay(
                            isSelected
                                ? Circle().fill(VColor.auxWhite).frame(width: 6, height: 6)
                                : nil
                        )
                        .frame(width: 18, height: 18)
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(isSelected ? VColor.primaryBase.opacity(0.1) : Color.clear)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(
                                isSelected ? VColor.primaryBase.opacity(0.5)
                                    : (comingSoon ? VColor.borderDisabled : VColor.borderBase),
                                lineWidth: 1
                            )
                    )
            )
            .opacity(comingSoon ? 0.7 : 1.0)
        }
        .buttonStyle(.plain)
        .disabled(comingSoon)
        .pointerCursor()
    }

    // MARK: - Helpers

    private var canContinue: Bool {
        state.selectedHostingMode == .local
    }

    private var continueButtonTitle: String {
        if isAuthenticated {
            return "Hatch"
        }
        return "Continue"
    }

    private func handleContinue() {
        guard canContinue else { return }

        state.cloudProvider = state.selectedHostingMode.rawValue

        if isAuthenticated {
            // Authenticated user selecting Local: skip API key, go straight to hatching
            saveModelToConfig("claude-opus-4-6")
            state.isHatching = true
        } else {
            // Skipped auth: advance to API key entry (step 2)
            state.advance()
        }
    }

    private func goBack() {
        withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
            state.currentStep -= 1
        }
    }

    private func saveModelToConfig(_ model: String) {
        let configURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".vellum/workspace/config.json")

        let dirURL = configURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: true)

        do {
            let data = try Data(contentsOf: configURL)
            if var json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                json["model"] = model
                let updated = try JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys])
                try updated.write(to: configURL)
            }
        } catch {
            let json: [String: Any] = ["model": model]
            if let data = try? JSONSerialization.data(withJSONObject: json, options: .prettyPrinted) {
                try? data.write(to: configURL)
            }
        }
    }
}
