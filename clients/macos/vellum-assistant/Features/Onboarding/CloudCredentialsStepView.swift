import VellumAssistantShared
import SwiftUI

@MainActor
struct CloudCredentialsStepView: View {
    @Bindable var state: OnboardingState

    @State private var showTitle = false
    @State private var showContent = false

    @State private var awsRoleArn: String = ""
    @State private var gcpProjectId: String = ""
    @State private var gcpServiceAccountKey: String = ""
    @State private var sshHost: String = ""
    @State private var sshUser: String = ""
    @State private var sshPrivateKey: String = ""

    @FocusState private var arnFieldFocused: Bool
    @FocusState private var projectIdFieldFocused: Bool
    @FocusState private var sshHostFieldFocused: Bool

    private var isAws: Bool {
        state.cloudProvider == "aws"
    }

    private var isCustomHardware: Bool {
        state.cloudProvider == "customHardware"
    }

    var body: some View {
        Text(titleText)
            .font(.system(size: 32, weight: .regular, design: .serif))
            .foregroundColor(VColor.textPrimary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        Text(subtitleText)
            .font(.system(size: 16))
            .foregroundColor(VColor.textSecondary)
            .multilineTextAlignment(.center)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)

        Spacer()

        VStack(spacing: VSpacing.md) {
            if isCustomHardware {
                customHardwareFields
            } else if isAws {
                awsFields
            } else {
                gcpFields
            }

            continueButton

            backButton

            OnboardingFooter(currentStep: state.currentStep, totalSteps: 4)
        }
        .padding(.horizontal, VSpacing.xxl)
        .padding(.bottom, VSpacing.lg)
        .opacity(showContent ? 1 : 0)
        .offset(y: showContent ? 0 : 12)
        .onAppear {
            loadCredentialsFromConfig()
            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                showContent = true
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                if isCustomHardware {
                    sshHostFieldFocused = true
                } else if isAws {
                    arnFieldFocused = true
                } else {
                    projectIdFieldFocused = true
                }
            }
        }
    }

    // MARK: - AWS Fields

    private var awsFields: some View {
        VStack(spacing: VSpacing.sm) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("IAM Role ARN")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(VColor.textSecondary)
                TextField("arn:aws:iam::123456789012:role/VellumAssistantRole", text: $awsRoleArn)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14, weight: .medium, design: .monospaced))
                    .foregroundColor(VColor.textPrimary)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.vertical, VSpacing.md)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
                    .focused($arnFieldFocused)
                    .onSubmit {
                        saveAndContinue()
                    }
            }

            Text("Create an IAM role that grants Vellum permission to provision and manage EC2 instances in your account.")
                .font(.system(size: 12))
                .foregroundColor(VColor.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Custom Hardware Fields

    private var customHardwareFields: some View {
        VStack(spacing: VSpacing.sm) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Host")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(VColor.textSecondary)
                TextField("192.168.1.100 or my-mac-mini.local", text: $sshHost)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14, weight: .medium, design: .monospaced))
                    .foregroundColor(VColor.textPrimary)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.vertical, VSpacing.md)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
                    .focused($sshHostFieldFocused)
            }

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Username")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(VColor.textSecondary)
                TextField("admin", text: $sshUser)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14, weight: .medium, design: .monospaced))
                    .foregroundColor(VColor.textPrimary)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.vertical, VSpacing.md)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
            }

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("SSH Private Key")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(VColor.textSecondary)
                TextEditor(text: $sshPrivateKey)
                    .font(.system(size: 12, weight: .regular, design: .monospaced))
                    .foregroundColor(VColor.textPrimary)
                    .scrollContentBackground(.hidden)
                    .padding(VSpacing.sm)
                    .frame(height: 120)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
            }

            Text("Provide SSH credentials so we can connect to your machine and run the assistant remotely.")
                .font(.system(size: 12))
                .foregroundColor(VColor.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - GCP Fields

    private var gcpFields: some View {
        VStack(spacing: VSpacing.sm) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Project ID")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(VColor.textSecondary)
                TextField("my-gcp-project-id", text: $gcpProjectId)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14, weight: .medium, design: .monospaced))
                    .foregroundColor(VColor.textPrimary)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.vertical, VSpacing.md)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
                    .focused($projectIdFieldFocused)
            }

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Service Account Key (JSON)")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(VColor.textSecondary)
                TextEditor(text: $gcpServiceAccountKey)
                    .font(.system(size: 12, weight: .regular, design: .monospaced))
                    .foregroundColor(VColor.textPrimary)
                    .scrollContentBackground(.hidden)
                    .padding(VSpacing.sm)
                    .frame(height: 120)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
            }

            Text("Create a service account with Compute Admin permissions and paste its JSON key here.")
                .font(.system(size: 12))
                .foregroundColor(VColor.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Buttons

    private var continueButton: some View {
        Button(action: { saveAndContinue() }) {
            Text("Continue")
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(adaptiveColor(light: .white, dark: .white))
                .frame(maxWidth: .infinity)
                .padding(.vertical, VSpacing.lg)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .fill(continueDisabled
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
        .disabled(continueDisabled)
        .onHover { hovering in
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }

    private var backButton: some View {
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
    }

    // MARK: - Helpers

    private var titleText: String {
        if isCustomHardware {
            return "Connect your hardware"
        } else if isAws {
            return "Connect your AWS account"
        } else {
            return "Connect your GCP project"
        }
    }

    private var subtitleText: String {
        if isCustomHardware {
            return "Provide SSH details so we can connect to your machine and run the assistant."
        } else if isAws {
            return "Provide your IAM Role ARN so we can provision resources in your AWS account."
        } else {
            return "Provide your project details so we can provision resources in your GCP project."
        }
    }

    private var continueDisabled: Bool {
        if isCustomHardware {
            return sshHost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || sshUser.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || sshPrivateKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        } else if isAws {
            return awsRoleArn.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        } else {
            return gcpProjectId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || gcpServiceAccountKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private func goBack() {
        withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
            state.currentStep = 1
        }
    }

    private func saveAndContinue() {
        guard !continueDisabled else { return }
        saveCredentialsToConfig()
        state.advance()
    }

    private func saveCredentialsToConfig() {
        let configURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".vellum/workspace/config.json")

        let dirURL = configURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: true)

        var credentials: [String: Any] = [:]
        if isCustomHardware {
            credentials["provider"] = "customHardware"
            credentials["sshHost"] = sshHost.trimmingCharacters(in: .whitespacesAndNewlines)
            credentials["sshUser"] = sshUser.trimmingCharacters(in: .whitespacesAndNewlines)
            credentials["sshPrivateKey"] = sshPrivateKey.trimmingCharacters(in: .whitespacesAndNewlines)
        } else if isAws {
            credentials["provider"] = "aws"
            credentials["roleArn"] = awsRoleArn.trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            credentials["provider"] = "gcp"
            credentials["projectId"] = gcpProjectId.trimmingCharacters(in: .whitespacesAndNewlines)
            credentials["serviceAccountKey"] = gcpServiceAccountKey.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        do {
            let data = try Data(contentsOf: configURL)
            if var json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                json["cloudCredentials"] = credentials
                let updated = try JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys])
                try updated.write(to: configURL)
            }
        } catch {
            let json: [String: Any] = ["cloudCredentials": credentials]
            if let data = try? JSONSerialization.data(withJSONObject: json, options: .prettyPrinted) {
                try? data.write(to: configURL)
            }
        }
    }

    private func loadCredentialsFromConfig() {
        let configURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".vellum/workspace/config.json")
        guard let data = try? Data(contentsOf: configURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let creds = json["cloudCredentials"] as? [String: Any] else {
            return
        }
        if let roleArn = creds["roleArn"] as? String {
            awsRoleArn = roleArn
        }
        if let projectId = creds["projectId"] as? String {
            gcpProjectId = projectId
        }
        if let key = creds["serviceAccountKey"] as? String {
            gcpServiceAccountKey = key
        }
        if let host = creds["sshHost"] as? String {
            sshHost = host
        }
        if let user = creds["sshUser"] as? String {
            sshUser = user
        }
        if let privKey = creds["sshPrivateKey"] as? String {
            sshPrivateKey = privKey
        }
    }
}

#Preview("AWS") {
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
            CloudCredentialsStepView(state: {
                let s = OnboardingState()
                s.currentStep = 2
                s.cloudProvider = "aws"
                return s
            }())
        }
    }
    .frame(width: 460, height: 620)
}

#Preview("GCP") {
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
            CloudCredentialsStepView(state: {
                let s = OnboardingState()
                s.currentStep = 2
                s.cloudProvider = "gcp"
                return s
            }())
        }
    }
    .frame(width: 460, height: 620)
}

#Preview("Custom Hardware") {
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
            CloudCredentialsStepView(state: {
                let s = OnboardingState()
                s.currentStep = 2
                s.cloudProvider = "customHardware"
                return s
            }())
        }
    }
    .frame(width: 460, height: 620)
}
