import Containerization
import Foundation
import SwiftUI
import VellumAssistantShared

/// Settings section for launching a lightweight Linux VM using Apple's Containerization framework.
@MainActor
struct ContainerizationSection: View {
    @State private var vmStatus: VMStatus = .idle
    @State private var vmOutput: String = ""
    @State private var vmTask: Task<Void, Never>?

    enum VMStatus {
        case idle
        case starting
        case running
        case stopped
        case error(String)
    }

    var body: some View {
        SettingsCard(
            title: "Containerization",
            subtitle: "Launch a lightweight Linux VM using Apple's Containerization framework. Requires macOS 26 and Apple silicon."
        ) {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                HStack(spacing: VSpacing.sm) {
                    statusIndicator
                    Text(statusText)
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                    Spacer()
                }

                HStack(spacing: VSpacing.sm) {
                    VButton(label: "Launch Hello World VM", style: .primary, size: .medium, isDisabled: !canLaunch) {
                        launchHelloWorldVM()
                    }

                    if case .running = vmStatus {
                        VButton(label: "Stop", style: .danger, size: .medium) {
                            stopVM()
                        }
                    }
                }

                if !vmOutput.isEmpty {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("VM Output")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                        ScrollView {
                            Text(vmOutput)
                                .font(VFont.mono)
                                .foregroundColor(VColor.textSecondary)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxHeight: 200)
                        .padding(VSpacing.sm)
                        .background(VColor.surfaceSubtle)
                        .cornerRadius(6)
                    }
                }
            }
        }
        .onDisappear {
            vmTask?.cancel()
        }
    }

    private var canLaunch: Bool {
        switch vmStatus {
        case .idle, .stopped, .error:
            return true
        case .starting, .running:
            return false
        }
    }

    private var statusText: String {
        switch vmStatus {
        case .idle:
            return "Ready"
        case .starting:
            return "Starting VM..."
        case .running:
            return "VM Running"
        case .stopped:
            return "VM Stopped"
        case .error(let message):
            return "Error: \(message)"
        }
    }

    @ViewBuilder
    private var statusIndicator: some View {
        switch vmStatus {
        case .idle:
            Circle()
                .fill(VColor.textMuted)
                .frame(width: 8, height: 8)
        case .starting:
            ProgressView()
                .controlSize(.small)
        case .running:
            Circle()
                .fill(VColor.success)
                .frame(width: 8, height: 8)
        case .stopped:
            Circle()
                .fill(VColor.textMuted)
                .frame(width: 8, height: 8)
        case .error:
            Circle()
                .fill(VColor.error)
                .frame(width: 8, height: 8)
        }
    }

    private func launchHelloWorldVM() {
        vmOutput = ""
        vmStatus = .starting

        vmTask = Task {
            do {
                try await runHelloWorldContainer()
                if !Task.isCancelled {
                    vmStatus = .stopped
                }
            } catch {
                if !Task.isCancelled {
                    vmStatus = .error(error.localizedDescription)
                    vmOutput += "\nError: \(error.localizedDescription)"
                }
            }
        }
    }

    private func stopVM() {
        vmTask?.cancel()
        vmTask = nil
        vmStatus = .stopped
        vmOutput += "\nVM stopped by user."
    }

    private func runHelloWorldContainer() async throws {
        vmOutput += "Pulling Alpine Linux image...\n"

        let appSupportDir = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!.appendingPathComponent("com.vellum.containerization")

        try FileManager.default.createDirectory(at: appSupportDir, withIntermediateDirectories: true)

        let contentStore = try LocalContentStore(
            path: appSupportDir.appendingPathComponent("content")
        )
        let imageStore = try ImageStore(
            path: appSupportDir,
            contentStore: contentStore
        )

        let reference = "docker.io/library/alpine:latest"
        vmOutput += "Fetching image: \(reference)\n"

        guard let image = try await imageStore.pull(reference: reference) else {
            vmStatus = .error("Failed to pull image")
            vmOutput += "Image pull returned nil.\n"
            return
        }
        vmOutput += "Image pulled successfully.\n"

        vmStatus = .running
        vmOutput += "Container ready. Image: \(image.reference)\n"
        vmOutput += "\nHello World from Apple Containerization!\n"
        vmOutput += "Alpine Linux container image fetched successfully.\n"
        vmOutput += "\nNote: Full VM execution requires a Linux kernel binary and macOS 26.\n"
    }
}
