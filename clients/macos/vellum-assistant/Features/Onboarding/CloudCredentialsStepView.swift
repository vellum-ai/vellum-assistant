import VellumAssistantShared
import SwiftUI
import UniformTypeIdentifiers

@MainActor
struct CloudCredentialsStepView: View {
    @Bindable var state: OnboardingState

    @State private var assistantCli = AssistantCli()
    @State private var showTitle = false
    @State private var showContent = false

    @State private var gcpServiceAccountFileName: String = ""
    @State private var sshPrivateKeyFileName: String = ""
    @State private var qrCodeImageFileName: String = ""

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
            .foregroundColor(VColor.contentDefault)
            .textSelection(.enabled)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        Text(subtitleText)
            .font(.system(size: 16))
            .foregroundColor(VColor.contentSecondary)
            .multilineTextAlignment(.center)
            .textSelection(.enabled)
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
            if !state.gcpServiceAccountKey.isEmpty {
                gcpServiceAccountFileName = "service-account-key.json"
            }
            if !state.sshPrivateKey.isEmpty {
                sshPrivateKeyFileName = "id_rsa"
            }
            if !state.customQRCodeImageData.isEmpty {
                qrCodeImageFileName = "qr-code.png"
            } else if isCustomHardware {
                // Auto-detect QR code PNG from the well-known XDG data path
                // where fetch-qr-code.sh places it after SCP from the Mac mini.
                let xdgDataHome = ProcessInfo.processInfo.environment["XDG_DATA_HOME"]
                    ?? (FileManager.default.homeDirectoryForCurrentUser.path + "/.local/share")
                let qrPath = URL(fileURLWithPath: xdgDataHome)
                    .appendingPathComponent("vellum/pairing-qr/initial.png")
                if let data = try? Data(contentsOf: qrPath), !data.isEmpty {
                    state.customQRCodeImageData = data
                    qrCodeImageFileName = "initial.png"
                }
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                showContent = true
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                if isCustomHardware {
                    // No text field to focus for custom hardware — just the file picker
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
            awsSetupBlurb

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("IAM Role ARN")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(VColor.contentSecondary)
                TextField("arn:aws:iam::123456789012:role/VellumAssistantRole", text: $state.awsRoleArn)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14, weight: .medium, design: .monospaced))
                    .foregroundColor(VColor.contentDefault)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.vertical, VSpacing.md)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                    .focused($arnFieldFocused)
                    .onSubmit {
                        saveAndContinue()
                    }
            }
        }
    }

    // MARK: - Custom Hardware Fields

    private var customHardwareFields: some View {
        VStack(spacing: VSpacing.sm) {
            customHardwareSetupBlurb

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("QR Code Image")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(VColor.contentSecondary)
                filePickerButton(
                    fileName: qrCodeImageFileName,
                    prompt: "Select QR Code PNG",
                    onPick: { pickQRCodeImageFile() },
                    onClear: {
                        state.customQRCodeImageData = Data()
                        qrCodeImageFileName = ""
                    }
                )
            }

        }
    }

    private static let gcpZones = [
        "us-central1-a",
        "us-east1-b",
        "us-east4-a",
        "us-west1-a",
        "us-west2-a",
    ]

    // MARK: - GCP Fields

    private var gcpFields: some View {
        VStack(spacing: VSpacing.sm) {
            gcpSetupBlurb

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Project ID")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(VColor.contentSecondary)
                TextField("my-gcp-project-id", text: $state.gcpProjectId)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14, weight: .medium, design: .monospaced))
                    .foregroundColor(VColor.contentDefault)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.vertical, VSpacing.md)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                    .focused($projectIdFieldFocused)
            }

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Zone")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(VColor.contentSecondary)
                Picker("", selection: $state.gcpZone) {
                    ForEach(Self.gcpZones, id: \.self) { zone in
                        Text(zone).tag(zone)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .font(.system(size: 14, weight: .medium, design: .monospaced))
                .foregroundColor(VColor.contentDefault)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xs)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.borderBase, lineWidth: 1)
                )
            }

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Service Account Key (JSON)")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(VColor.contentSecondary)
                filePickerButton(
                    fileName: gcpServiceAccountFileName,
                    prompt: "Select Service Account JSON File",
                    onPick: { pickGCPServiceAccountFile() },
                    onClear: {
                        state.gcpServiceAccountKey = ""
                        gcpServiceAccountFileName = ""
                    }
                )
            }
        }
    }

    private var awsSetupBlurb: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Before continuing, set up the following in the AWS Console:")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(VColor.contentSecondary)
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                setupStep("1. Create an IAM role with EC2 full access permissions (e.g., AmazonEC2FullAccess).")
                setupStep("2. Configure the role's trust policy to allow Vellum to assume it.")
                setupStep("3. Ensure your account has a default VPC in the target region.")
            }
            Link(destination: URL(string: "https://console.aws.amazon.com/iam/home#/roles")!) {
                Text("Open AWS IAM Console")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(VColor.primaryBase)
            }
            .pointerCursor()
        }
        .padding(VSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surfaceActive)
        )
    }

    private var customHardwareSetupBlurb: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Set up your Mac mini, then upload the QR code:")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(VColor.contentSecondary)
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                setupStep("1. On your Mac mini, run: curl -fsSL https://assistant.vellum.ai/install.sh | bash")
                setupStep("2. Upload the QR code PNG generated by the install script below.")
            }
        }
        .padding(VSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surfaceActive)
        )
    }

    private var gcpSetupBlurb: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Before continuing, set up the following in the Google Cloud Console:")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(VColor.contentSecondary)
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                setupStep("1. Create or select a GCP project with the Compute Engine API enabled.")
                setupStep("2. Create a Service Account with the Compute Admin role.")
                setupStep("3. Generate a JSON key for the service account and download it.")
            }
            Link(destination: URL(string: "https://console.cloud.google.com/iam-admin/serviceaccounts")!) {
                Text("Open Google Cloud Console")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(VColor.primaryBase)
            }
            .pointerCursor()
        }
        .padding(VSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surfaceActive)
        )
    }

    private func setupStep(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 12))
            .foregroundColor(VColor.contentTertiary)
    }

    // MARK: - File Picker UI

    @ViewBuilder
    private func filePickerButton(
        fileName: String,
        prompt: String,
        onPick: @escaping () -> Void,
        onClear: @escaping () -> Void
    ) -> some View {
        if fileName.isEmpty {
            Button(action: onPick) {
                HStack(spacing: VSpacing.sm) {
                    VIconView(.filePlus, size: 14)
                        .foregroundColor(VColor.contentSecondary)
                    Text(prompt)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundColor(VColor.contentSecondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, VSpacing.lg)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.borderBase, style: StrokeStyle(lineWidth: 1, dash: [6, 3]))
                )
            }
            .buttonStyle(.plain)
            .pointerCursor()
        } else {
            HStack(spacing: VSpacing.sm) {
                VIconView(.file, size: 14)
                    .foregroundColor(VColor.primaryBase)
                Text(fileName)
                    .font(.system(size: 14, weight: .medium, design: .monospaced))
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                Spacer()
                Button(action: onClear) {
                    VIconView(.circleX, size: 14)
                        .foregroundColor(VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .pointerCursor()
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(VColor.borderBase, lineWidth: 1)
            )
        }
    }

    // MARK: - File Picking

    private func pickGCPServiceAccountFile() {
        let panel = NSOpenPanel()
        panel.title = "Select Service Account JSON File"
        panel.allowedContentTypes = [UTType.json]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false

        if panel.runModal() == .OK, let url = panel.url {
            do {
                let contents = try String(contentsOf: url, encoding: .utf8)
                state.gcpServiceAccountKey = contents
                gcpServiceAccountFileName = url.lastPathComponent
            } catch {
                state.gcpServiceAccountKey = ""
                gcpServiceAccountFileName = ""
            }
        }
    }

    private func pickSSHKeyFile() {
        let panel = NSOpenPanel()
        panel.title = "Select SSH Private Key File"
        panel.allowedContentTypes = [UTType.data, UTType.plainText]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.showsHiddenFiles = true
        panel.treatsFilePackagesAsDirectories = true

        if panel.runModal() == .OK, let url = panel.url {
            do {
                let contents = try String(contentsOf: url, encoding: .utf8)
                state.sshPrivateKey = contents
                sshPrivateKeyFileName = url.lastPathComponent
            } catch {
                state.sshPrivateKey = ""
                sshPrivateKeyFileName = ""
            }
        }
    }

    private func pickQRCodeImageFile() {
        let panel = NSOpenPanel()
        panel.title = "Select QR Code PNG"
        panel.allowedContentTypes = [UTType.png, UTType.image]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false

        if panel.runModal() == .OK, let url = panel.url {
            do {
                let data = try Data(contentsOf: url)
                state.customQRCodeImageData = data
                qrCodeImageFileName = url.lastPathComponent
            } catch {
                state.customQRCodeImageData = Data()
                qrCodeImageFileName = ""
            }
        }
    }

    // MARK: - Buttons

    private var continueButton: some View {
        OnboardingButton(
            title: "Continue",
            style: .primary,
            disabled: continueDisabled
        ) {
            saveAndContinue()
        }
    }

    private var backButton: some View {
        Button(action: { goBack() }) {
            Text("Back")
                .font(.system(size: 13))
                .foregroundColor(VColor.contentTertiary)
        }
        .buttonStyle(.plain)
        .pointerCursor()
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
            return "Upload the QR code from your Mac mini to pair with the assistant."
        } else if isAws {
            return "Provide your IAM Role ARN so we can provision resources in your AWS account."
        } else {
            return "Provide your project details so we can provision resources in your GCP project."
        }
    }

    private var continueDisabled: Bool {
        if isCustomHardware {
            return state.customQRCodeImageData.isEmpty
        } else if isAws {
            return state.awsRoleArn.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        } else {
            return state.gcpProjectId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || state.gcpServiceAccountKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private func goBack() {
        withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
            state.currentStep = 1
        }
    }

    private func saveAndContinue() {
        guard !continueDisabled else { return }
        state.advance()
    }
}
