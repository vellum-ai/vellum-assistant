import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ReauthView")

@MainActor
struct ReauthView: View {
    @Bindable var authManager: AuthManager
    var onComplete: () -> Void

    @State private var showContent = false
    @State private var didComplete = false

    private var hasNonManagedAssistant: Bool {
        LockfileAssistant.loadAll().contains { !$0.isManaged }
    }

    private static let appIcon: NSImage? = {
        guard let path = ResourceBundle.bundle.path(forResource: "vellum-app-icon", ofType: "png") else { return nil }
        return NSImage(contentsOfFile: path)
    }()

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            if let nsImage = Self.appIcon {
                Image(nsImage: nsImage)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 96, height: 96)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
                    .padding(.bottom, VSpacing.xl)
            }

            Text("Welcome Back")
                .font(.system(size: 32, weight: .regular, design: .serif))
                .foregroundColor(VColor.contentDefault)
                .padding(.bottom, VSpacing.xs)

            Text("Log in to continue.")
                .font(.system(size: 16))
                .foregroundColor(VColor.contentSecondary)
                .padding(.bottom, VSpacing.xxl)

            VStack(spacing: VSpacing.md) {
                if authManager.isLoading {
                    HStack(spacing: VSpacing.sm) {
                        ProgressView()
                            .controlSize(.small)
                            .progressViewStyle(.circular)
                        Text("Checking...")
                            .font(VFont.monoMedium)
                            .foregroundColor(VColor.contentSecondary)
                    }
                    .frame(height: 36)
                } else if authManager.isSubmitting {
                    HStack(spacing: VSpacing.sm) {
                        ProgressView()
                            .controlSize(.small)
                            .progressViewStyle(.circular)
                        Text("Logging in...")
                            .font(VFont.monoMedium)
                            .foregroundColor(VColor.contentSecondary)
                    }
                    .frame(height: 36)
                } else {
                    OnboardingButton(title: "Log In", style: .primary) {
                        Task {
                            await authManager.startWorkOSLogin()
                        }
                    }
                    .accessibilityLabel("Log In")
                }

                if let error = authManager.errorMessage {
                    Text(error)
                        .font(VFont.caption)
                        .foregroundColor(VColor.systemNegativeStrong)
                        .multilineTextAlignment(.center)
                }

                if hasNonManagedAssistant {
                    OnboardingButton(title: "Skip", style: .ghost) {
                        if let nonManaged = LockfileAssistant.loadAll().first(where: { !$0.isManaged }) {
                            UserDefaults.standard.set(nonManaged.assistantId, forKey: "connectedAssistantId")
                        }
                        onComplete()
                    }
                    .accessibilityLabel("Skip")
                }
            }
            .frame(maxWidth: 280)

            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            RadialGradient(
                colors: [VColor.surfaceBase, VColor.surfaceOverlay],
                center: .center,
                startRadius: 0,
                endRadius: 500
            )
            .ignoresSafeArea()
        )
        .opacity(showContent ? 1 : 0)
        .onAppear {
            withAnimation(.easeOut(duration: 0.4)) {
                showContent = true
            }
        }
        .task {
            if !authManager.isAuthenticated {
                await authManager.checkSession()
            }
            if authManager.isAuthenticated && !didComplete {
                didComplete = true
                onComplete()
            }
        }
        .onChange(of: authManager.isAuthenticated) { _, isAuthenticated in
            if isAuthenticated && !didComplete {
                didComplete = true
                log.info("User re-authenticated — proceeding to app")
                onComplete()
            }
        }
    }
}
