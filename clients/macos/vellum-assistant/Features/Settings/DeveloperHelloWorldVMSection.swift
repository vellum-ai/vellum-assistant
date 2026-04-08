import Foundation
import SwiftUI
import VellumAssistantShared

@MainActor
final class DeveloperHelloWorldVMModel: ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var output = ""
    @Published private(set) var errorMessage: String?
    @Published private(set) var lastKernelPath: String?

    private let service: DeveloperHelloWorldVMService
    private var runTask: Task<Void, Never>?

    init(service: DeveloperHelloWorldVMService = DeveloperHelloWorldVMService()) {
        self.service = service
    }

    func runHelloWorldVM() {
        guard runTask == nil else { return }

        isRunning = true
        errorMessage = nil
        output = ""

        let service = self.service
        runTask = Task(priority: .userInitiated) { [weak self] in
            defer {
                Task { @MainActor [weak self] in
                    self?.isRunning = false
                    self?.runTask = nil
                }
            }

            do {
                let updateOutput: @MainActor (String) -> Void = { [weak self] message in
                    self?.appendOutput(message)
                }
                let result = try await service.runHelloWorld { message in
                    await updateOutput(message)
                }

                await MainActor.run { [weak self] in
                    self?.lastKernelPath = result.kernelURL.path
                    let trimmedStderr = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmedStderr.isEmpty {
                        self?.appendOutput("stderr:\n\(trimmedStderr)")
                    }
                }
            } catch is CancellationError {
                await MainActor.run { [weak self] in
                    self?.appendOutput("VM launch cancelled.")
                }
            } catch {
                await MainActor.run { [weak self] in
                    self?.errorMessage = error.localizedDescription
                    self?.appendOutput("Error:\n\(error.localizedDescription)")
                }
            }
        }
    }

    func cancel() {
        runTask?.cancel()
    }

    private func appendOutput(_ chunk: String) {
        if output.isEmpty {
            output = chunk
        } else {
            output += "\n\n" + chunk
        }
    }
}

struct DeveloperHelloWorldVMSection: View {
    @StateObject private var model = DeveloperHelloWorldVMModel()

    var body: some View {
        SettingsCard(
            title: "Hello World VM",
            subtitle: "Runs a tiny Alpine container with Apple containerization and the app-bundled Kata 3.17.0 ARM64 kernel."
        ) {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                HStack(spacing: VSpacing.sm) {
                    VButton(
                        label: model.isRunning ? "Launching..." : "Run Hello World VM",
                        leftIcon: VIcon.play.rawValue,
                        style: .primary,
                        isDisabled: model.isRunning
                    ) {
                        model.runHelloWorldVM()
                    }

                    if model.isRunning {
                        HStack(spacing: VSpacing.xs) {
                            VBusyIndicator(size: 10, color: VColor.primaryBase)
                            Text("Downloading the kernel and starting the VM...")
                                .font(VFont.labelDefault)
                                .foregroundColor(VColor.contentTertiary)
                        }
                    }
                }

                Link("Apple containerization package", destination: DeveloperHelloWorldVMService.containerizationRepositoryURL)
                    .font(VFont.labelDefault)
                    .foregroundColor(VColor.primaryBase)

                if let kernelPath = model.lastKernelPath, !kernelPath.isEmpty {
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text("Kernel")
                            .font(VFont.labelDefault)
                            .foregroundColor(VColor.contentTertiary)
                        Text(kernelPath)
                            .font(Font(VFont.nsMono))
                            .foregroundColor(VColor.contentDefault)
                            .textSelection(.enabled)
                    }
                }

                if let errorMessage = model.errorMessage {
                    HStack(alignment: .top, spacing: VSpacing.xs) {
                        VIconView(.triangleAlert, size: 12)
                            .foregroundColor(VColor.systemNegativeStrong)
                            .padding(.top, 2)
                        Text(errorMessage)
                            .font(VFont.labelDefault)
                            .foregroundColor(VColor.systemNegativeStrong)
                            .textSelection(.enabled)
                    }
                }

                if !model.output.isEmpty {
                    ScrollView {
                        Text(model.output)
                            .font(Font(VFont.nsMono))
                            .foregroundColor(VColor.contentDefault)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(minHeight: 120, maxHeight: 220)
                    .padding(VSpacing.md)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .fill(VColor.surfaceBase)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.borderDisabled, lineWidth: 1)
                    )
                }
            }
        }
        .onDisappear {
            model.cancel()
        }
    }
}
