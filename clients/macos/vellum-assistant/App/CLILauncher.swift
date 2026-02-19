import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "CLILauncher")

@MainActor
final class CLILauncher {

    enum CLIError: LocalizedError {
        case binaryNotFound
        case executionFailed(String)

        var errorDescription: String? {
            switch self {
            case .binaryNotFound:
                return "CLI binary not found in app bundle"
            case .executionFailed(let message):
                return "CLI command failed: \(message)"
            }
        }
    }

    private var cliBinaryURL: URL? {
        guard let execURL = Bundle.main.executableURL else { return nil }
        let candidate = execURL.deletingLastPathComponent().appendingPathComponent("vellum-cli")
        return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
    }

    func runHatch() async throws {
        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping hatch (dev mode)")
            throw CLIError.binaryNotFound
        }

        log.info("Running hatch via CLI at \(binaryURL.path)")

        let proc = Process()
        proc.executableURL = binaryURL
        proc.arguments = ["hatch", "-d"]

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        proc.standardOutput = stdoutPipe
        proc.standardError = stderrPipe

        var env = ProcessInfo.processInfo.environment
        env["HOME"] = FileManager.default.homeDirectoryForCurrentUser.path
        proc.environment = env

        try proc.run()
        log.info("CLI hatch launched with pid \(proc.processIdentifier)")

        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()

        let status = proc.terminationStatus
        if status != 0 {
            let stderrString = String(data: stderrData, encoding: .utf8) ?? ""
            log.error("CLI hatch failed with exit code \(status): \(stderrString)")
            throw CLIError.executionFailed(stderrString)
        }

        log.info("CLI hatch completed successfully")
    }

    func runRetire(name: String) async throws {
        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping retire (dev mode)")
            throw CLIError.binaryNotFound
        }

        log.info("Running retire via CLI at \(binaryURL.path) for '\(name)'")

        let proc = Process()
        proc.executableURL = binaryURL
        proc.arguments = ["retire", name]

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        proc.standardOutput = stdoutPipe
        proc.standardError = stderrPipe

        var env = ProcessInfo.processInfo.environment
        env["HOME"] = FileManager.default.homeDirectoryForCurrentUser.path
        proc.environment = env

        try proc.run()
        log.info("CLI retire launched with pid \(proc.processIdentifier)")

        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()

        let status = proc.terminationStatus
        if status != 0 {
            let stderrString = String(data: stderrData, encoding: .utf8) ?? ""
            log.error("CLI retire failed with exit code \(status): \(stderrString)")
            throw CLIError.executionFailed(stderrString)
        }

        log.info("CLI retire completed successfully")
    }

    struct RemoteHatchConfig {
        let remote: String
        var gcpProjectId: String = ""
        var gcpZone: String = ""
        var gcpServiceAccountKey: String = ""
        var awsRoleArn: String = ""
        var sshHost: String = ""
        var sshUser: String = ""
        var sshPrivateKey: String = ""
        var anthropicApiKey: String = ""
    }

    func runRemoteHatch(
        config: RemoteHatchConfig,
        onOutput: @escaping @Sendable (String) -> Void
    ) async throws {
        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping hatch (dev mode)")
            throw CLIError.binaryNotFound
        }

        log.info("Running remote hatch via CLI at \(binaryURL.path) --remote \(config.remote)")

        let proc = Process()
        proc.executableURL = binaryURL
        proc.arguments = ["hatch", "--remote", config.remote]

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        proc.standardOutput = stdoutPipe
        proc.standardError = stderrPipe

        var env = ProcessInfo.processInfo.environment
        env["HOME"] = FileManager.default.homeDirectoryForCurrentUser.path

        if !config.anthropicApiKey.isEmpty {
            env["ANTHROPIC_API_KEY"] = config.anthropicApiKey
        }

        if config.remote == "gcp" {
            if !config.gcpProjectId.isEmpty {
                env["GCP_PROJECT"] = config.gcpProjectId
            }
            if !config.gcpZone.isEmpty {
                env["GCP_DEFAULT_ZONE"] = config.gcpZone
            }
            if !config.gcpServiceAccountKey.isEmpty {
                let tmpKeyPath = FileManager.default.temporaryDirectory
                    .appendingPathComponent("vellum-sa-key-\(ProcessInfo.processInfo.processIdentifier).json")
                try config.gcpServiceAccountKey.write(to: tmpKeyPath, atomically: true, encoding: .utf8)
                env["GOOGLE_APPLICATION_CREDENTIALS"] = tmpKeyPath.path

                if let data = config.gcpServiceAccountKey.data(using: .utf8),
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let email = json["client_email"] as? String {
                    env["GCP_ACCOUNT_EMAIL"] = email
                }
            }
        } else if config.remote == "aws" {
            if !config.awsRoleArn.isEmpty {
                env["VELLUM_AWS_ROLE_ARN"] = config.awsRoleArn
            }
        } else if config.remote == "custom" {
            if !config.sshHost.isEmpty {
                let hostString = config.sshUser.isEmpty
                    ? config.sshHost
                    : "\(config.sshUser)@\(config.sshHost)"
                env["VELLUM_CUSTOM_HOST"] = hostString
            }
            if !config.sshPrivateKey.isEmpty {
                let tmpKeyPath = FileManager.default.temporaryDirectory
                    .appendingPathComponent("vellum-ssh-key-\(ProcessInfo.processInfo.processIdentifier)")
                try config.sshPrivateKey.write(to: tmpKeyPath, atomically: true, encoding: .utf8)
                try FileManager.default.setAttributes(
                    [.posixPermissions: 0o600],
                    ofItemAtPath: tmpKeyPath.path
                )
                env["VELLUM_SSH_KEY_PATH"] = tmpKeyPath.path
            }
        }

        proc.environment = env

        try proc.run()
        log.info("CLI remote hatch launched with pid \(proc.processIdentifier)")

        let stdoutHandle = stdoutPipe.fileHandleForReading
        let stderrHandle = stderrPipe.fileHandleForReading

        stdoutHandle.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else {
                return
            }
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                onOutput(trimmed)
            }
        }

        stderrHandle.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else {
                return
            }
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                onOutput(trimmed)
            }
        }

        proc.waitUntilExit()

        stdoutHandle.readabilityHandler = nil
        stderrHandle.readabilityHandler = nil

        let status = proc.terminationStatus
        if status != 0 {
            log.error("CLI remote hatch failed with exit code \(status)")
            throw CLIError.executionFailed("Hatch process exited with code \(status)")
        }

        log.info("CLI remote hatch completed successfully")
    }
}
