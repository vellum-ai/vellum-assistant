import VellumAssistantShared
import SwiftUI

@MainActor
struct ModelSelectionStepView: View {
    @Bindable var state: OnboardingState

    private var userHostedEnabled: Bool {
        FeatureFlagManager.shared.isEnabled(.userHostedEnabled)
    }

    @State private var showTitle = false
    @State private var showContent = false
    @State private var selectedModel = "claude-sonnet-4-5-20250929"

    private static let models: [(id: String, name: String, detail: String)] = [
        ("claude-opus-4-6", "Opus 4.6", "Most capable"),
        ("claude-sonnet-4-5-20250929", "Sonnet 4.5", "Balanced"),
        ("claude-haiku-4-5-20251001", "Haiku 4.5", "Fastest"),
    ]

    var body: some View {
        // Title
        Text("Choose your model")
            .font(.system(size: 32, weight: .regular, design: .serif))
            .foregroundColor(VColor.textPrimary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        // Subtitle
        Text("Pick the model that powers your assistant.")
            .font(.system(size: 16))
            .foregroundColor(VColor.textSecondary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)

        Spacer()

        // Content
        VStack(spacing: VSpacing.md) {
            // Model selection cards
            VStack(spacing: VSpacing.sm) {
                ForEach(Self.models, id: \.id) { model in
                    modelCard(id: model.id, name: model.name, detail: model.detail)
                }
            }

            // Primary button
            Button(action: { saveModelAndContinue() }) {
                Text("Select model")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundColor(adaptiveColor(light: .white, dark: .white))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, VSpacing.lg)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .fill(adaptiveColor(
                                light: Color(nsColor: NSColor(red: 0.12, green: 0.12, blue: 0.12, alpha: 1)),
                                dark: Violet._600
                            ))
                    )
            }
            .buttonStyle(.plain)
            .onHover { hovering in
                if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }

            Button(action: { goBack() }) {
                Text("Back")
                    .font(.system(size: 13))
                    .foregroundColor(VColor.textMuted)
            }
            .buttonStyle(.plain)
            .onHover { hovering in
                if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }
            .padding(.top, VSpacing.xs)

            OnboardingFooter(currentStep: state.currentStep, totalSteps: userHostedEnabled ? 4 : 3)
        }
        .padding(.horizontal, VSpacing.xxl)
        .padding(.bottom, VSpacing.lg)
        .opacity(showContent ? 1 : 0)
        .offset(y: showContent ? 0 : 12)
        .onAppear {
            if let existing = loadModelFromConfig() {
                selectedModel = existing
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                showContent = true
            }
        }
    }

    // MARK: - Model Card

    private func modelCard(id: String, name: String, detail: String) -> some View {
        let isSelected = selectedModel == id
        return Button(action: { selectedModel = id }) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(VColor.textPrimary)
                    Text(detail)
                        .font(.system(size: 12))
                        .foregroundColor(VColor.textSecondary)
                }
                Spacer()
                Circle()
                    .fill(isSelected ? Violet._600 : Color.clear)
                    .overlay(
                        Circle().stroke(isSelected ? Violet._600 : VColor.surfaceBorder, lineWidth: 1.5)
                    )
                    .overlay(
                        isSelected
                            ? Circle().fill(Color.white).frame(width: 6, height: 6)
                            : nil
                    )
                    .frame(width: 18, height: 18)
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(isSelected ? Violet._600.opacity(0.1) : Color.clear)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(isSelected ? Violet._600.opacity(0.5) : VColor.surfaceBorder, lineWidth: 1)
                    )
            )
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }

    // MARK: - Helpers

    private func goBack() {
        withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
            if userHostedEnabled && (state.cloudProvider == "local" || state.cloudProvider == "customHardware") {
                state.currentStep = 1
            } else {
                state.currentStep -= 1
            }
        }
    }

    private func saveModelAndContinue() {
        saveModelToConfig(selectedModel)
        state.advance()
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

    private func loadModelFromConfig() -> String? {
        let configURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".vellum/workspace/config.json")
        guard let data = try? Data(contentsOf: configURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let model = json["model"] as? String else {
            return nil
        }
        return model
    }
}

#Preview {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: 0) {
            Spacer()
            Image("VellyLogo")
                .resizable()
                .interpolation(.none)
                .aspectRatio(contentMode: .fit)
                .frame(width: 128, height: 128)
                .padding(.bottom, VSpacing.xxl)
            ModelSelectionStepView(state: {
                let s = OnboardingState()
                s.currentStep = 3
                return s
            }())
        }
    }
    .frame(width: 460, height: 620)
}
