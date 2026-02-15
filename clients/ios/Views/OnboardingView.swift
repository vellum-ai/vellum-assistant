#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct OnboardingView: View {
    @Binding var isCompleted: Bool
    @State private var currentStep = 0

    var body: some View {
        TabView(selection: $currentStep) {
            WelcomeStep()
                .tag(0)

            PermissionsStep()
                .tag(1)

            DaemonSetupStep()
                .tag(2)

            ReadyStep(isCompleted: $isCompleted)
                .tag(3)
        }
        .tabViewStyle(.page)
        .indexViewStyle(.page(backgroundDisplayMode: .always))
    }
}

struct WelcomeStep: View {
    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("✨")
                .font(.system(size: 80))

            Text("Welcome to Vellum Assistant")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)
                .multilineTextAlignment(.center)

            Text("AI-powered assistant for your iPhone")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)

            Spacer()

            Text("Swipe to continue")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .padding(.bottom, VSpacing.xxl)
        }
        .padding(VSpacing.xl)
    }
}

struct PermissionsStep: View {
    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("🎤")
                .font(.system(size: 80))

            Text("Permissions")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            Text("Grant permissions for voice input")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)

            VStack(spacing: VSpacing.lg) {
                PermissionRowView(permission: .microphone)
                PermissionRowView(permission: .speechRecognition)
            }
            .padding(VSpacing.xl)
            .background(VColor.surface)
            .cornerRadius(VRadius.md)

            Spacer()
        }
        .padding(VSpacing.xl)
    }
}

struct DaemonSetupStep: View {
    @State private var hostname = "localhost"
    @State private var port = "8765"
    @State private var showingAlert = false
    @State private var alertMessage = ""

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("🔌")
                .font(.system(size: 80))

            Text("Daemon Connection")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            Text("Enter your daemon hostname and port")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)

            VStack(spacing: VSpacing.lg) {
                TextField("Hostname", text: $hostname)
                    .textFieldStyle(.roundedBorder)
                    .autocapitalization(.none)

                TextField("Port", text: $port)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.numberPad)
            }
            .padding(VSpacing.xl)

            Button("Save") {
                guard let portInt = Int(port), portInt > 0, portInt <= 65535 else {
                    alertMessage = "Port must be a valid number between 1 and 65535"
                    showingAlert = true
                    return
                }
                UserDefaults.standard.set(hostname, forKey: "daemon_hostname")
                UserDefaults.standard.set(portInt, forKey: "daemon_port")
                alertMessage = "Settings saved successfully"
                showingAlert = true
            }
            .buttonStyle(.borderedProminent)

            Spacer()
        }
        .padding(VSpacing.xl)
        .alert("Daemon Setup", isPresented: $showingAlert) {
            Button("OK") {}
        } message: {
            Text(alertMessage)
        }
        .onAppear {
            hostname = UserDefaults.standard.string(forKey: "daemon_hostname") ?? "localhost"
            let portValue = UserDefaults.standard.integer(forKey: "daemon_port")
            port = portValue > 0 ? String(portValue) : "8765"
        }
    }
}

struct ReadyStep: View {
    @Binding var isCompleted: Bool

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("🎉")
                .font(.system(size: 80))

            Text("You're All Set!")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            Text("Start chatting with your AI assistant")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)

            Button("Get Started") {
                isCompleted = true
            }
            .buttonStyle(.borderedProminent)

            Spacer()
        }
        .padding(VSpacing.xl)
    }
}

#Preview {
    OnboardingView(isCompleted: .constant(false))
}
#endif
