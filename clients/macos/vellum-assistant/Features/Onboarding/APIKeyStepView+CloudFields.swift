import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

// MARK: - Inline Cloud Credential Fields

extension APIKeyStepView {

    @ViewBuilder
    var inlineCloudCredentialFields: some View {
        switch hostingMode {
        case .gcp:
            gcpInlineFields
        case .aws:
            awsInlineFields
        case .customHardware:
            customHardwareInlineFields
        default:
            EmptyView()
        }
    }

    var gcpInlineFields: some View {
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

    var awsInlineFields: some View {
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
            }
        }
    }

    var customHardwareInlineFields: some View {
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

    // MARK: - Setup Blurbs

    var gcpSetupBlurb: some View {
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

    var awsSetupBlurb: some View {
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

    var customHardwareSetupBlurb: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Set up your Mac mini, then upload the QR code:")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(VColor.contentSecondary)
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                setupStep("1. On your Mac mini, run: curl -fsSL https://vellum.ai/install.sh | bash")
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

    func setupStep(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 12))
            .foregroundColor(VColor.contentTertiary)
    }

    static var gcpZones: [String] {
        [
            "us-central1-a",
            "us-east1-b",
            "us-east4-a",
            "us-west1-a",
            "us-west2-a",
        ]
    }

    // MARK: - File Picker UI

    @ViewBuilder
    func filePickerButton(
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
                .accessibilityLabel("Remove file")
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

    func pickGCPServiceAccountFile() {
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

    func pickQRCodeImageFile() {
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
}
