import VellumAssistantShared
import SwiftUI

@MainActor
struct APIKeyStepView: View {
    @Bindable var state: OnboardingState

    @State private var apiKey: String = ""
    @State private var hasExistingKey = false
    @State private var isEditing = false
    @State private var showIcon = false
    @State private var showTitle = false
    @State private var showContent = false
    @FocusState private var keyFieldFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            // Icon
            Group {
                if let url = ResourceBundle.bundle.url(forResource: "stage-3", withExtension: "png"),
                   let nsImage = NSImage(contentsOf: url) {
                    Image(nsImage: nsImage)
                        .resizable()
                        .interpolation(.none)
                        .aspectRatio(contentMode: .fit)
                } else {
                    Image("VellyLogo")
                        .resizable()
                        .interpolation(.none)
                        .aspectRatio(contentMode: .fit)
                }
            }
            .frame(width: 128, height: 128)
            .opacity(showIcon ? 1 : 0)
            .scaleEffect(showIcon ? 1 : 0.8)
            .padding(.bottom, VSpacing.xxl)

            // Title
            Text("Add your API key")
                .font(.system(size: 32, weight: .regular, design: .serif))
                .foregroundColor(VColor.textPrimary)
                .opacity(showTitle ? 1 : 0)
                .offset(y: showTitle ? 0 : 8)
                .padding(.bottom, VSpacing.md)

            // Subtitle
            Text("Enter your Anthropic API key to get started.")
                .font(.system(size: 16))
                .foregroundColor(VColor.textSecondary)
                .opacity(showTitle ? 1 : 0)
                .offset(y: showTitle ? 0 : 8)

            Spacer()

            // Content
            VStack(spacing: VSpacing.md) {
                    if hasExistingKey && !isEditing {
                        // Show masked key: first 4 chars + dots + last 3 chars
                        Text(maskedKey)
                            .font(.system(size: 16, weight: .medium, design: .monospaced))
                            .foregroundColor(VColor.textPrimary)
                            .frame(maxWidth: .infinity)
                            .padding(.horizontal, 20)
                            .padding(.vertical, VSpacing.lg)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.lg)
                                    .stroke(VColor.surfaceBorder, lineWidth: 1)
                            )
                            .onTapGesture {
                                isEditing = true
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                                    keyFieldFocused = true
                                }
                            }
                    } else {
                        SecureField("sk-ant-\u{2026}", text: $apiKey)
                            .textFieldStyle(.plain)
                            .font(.system(size: 16, weight: .medium, design: .monospaced))
                            .foregroundColor(VColor.textPrimary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 20)
                            .padding(.vertical, VSpacing.lg)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.lg)
                                    .stroke(VColor.surfaceBorder, lineWidth: 1)
                            )
                            .focused($keyFieldFocused)
                            .onSubmit {
                                saveAndContinue()
                            }
                    }

                    Button(action: { saveAndContinue() }) {
                        Text("Save & Continue")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(adaptiveColor(
                                light: .white,
                                dark: .white
                            ))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, VSpacing.lg)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.lg)
                                    .fill(apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                        ? adaptiveColor(
                                            light: Color(nsColor: NSColor(red: 0.12, green: 0.12, blue: 0.12, alpha: 0.3)),
                                            dark: Violet._600.opacity(0.3)
                                        )
                                        : adaptiveColor(
                                            light: Color(nsColor: NSColor(red: 0.12, green: 0.12, blue: 0.12, alpha: 1)),
                                            dark: Violet._600
                                        )
                                    )
                            )
                    }
                    .buttonStyle(.plain)
                    .disabled(apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .onHover { hovering in
                        if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                    }

                    HStack(spacing: VSpacing.lg) {
                        Link(destination: URL(string: "https://console.anthropic.com/settings/keys")!) {
                            Text("Get an API key")
                                .font(.system(size: 13))
                                .foregroundColor(adaptiveColor(light: VColor.accent, dark: .white))
                        }
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
                    }
                    .padding(.top, VSpacing.xs)
            }
            .padding(.horizontal, VSpacing.xxl)
            .padding(.bottom, VSpacing.xxl)
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            ZStack {
                VColor.background

                // Purple glow at bottom
                RadialGradient(
                    colors: [
                        Violet._600.opacity(0.15),
                        Violet._700.opacity(0.05),
                        Color.clear
                    ],
                    center: .bottom,
                    startRadius: 20,
                    endRadius: 350
                )

                // Subtle secondary glow offset to bottom-right
                RadialGradient(
                    colors: [
                        Violet._400.opacity(0.08),
                        Color.clear
                    ],
                    center: UnitPoint(x: 0.7, y: 1.0),
                    startRadius: 10,
                    endRadius: 250
                )
            }
            .ignoresSafeArea()
        )
        .onAppear {
            if let existingKey = APIKeyManager.getKey() {
                apiKey = existingKey
                hasExistingKey = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.2)) {
                showIcon = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.5)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.8)) {
                showContent = true
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.3) {
                keyFieldFocused = true
            }
        }
    }

    private var maskedKey: String {
        guard apiKey.count > 7 else { return String(repeating: "\u{2022}", count: apiKey.count) }
        let prefix = String(apiKey.prefix(4))
        let suffix = String(apiKey.suffix(3))
        let dots = String(repeating: "\u{2022}", count: min(apiKey.count - 7, 20))
        return prefix + dots + suffix
    }

    private func goBack() {
        withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
            state.currentStep = 0
        }
    }

    private func saveAndContinue() {
        let trimmed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        APIKeyManager.setKey(trimmed)
        state.advance()
    }
}

#Preview {
    ZStack {
        VColor.background.ignoresSafeArea()
        APIKeyStepView(state: {
            let s = OnboardingState()
            s.currentStep = 2
            return s
        }())
    }
    .frame(width: 460, height: 520)
}
