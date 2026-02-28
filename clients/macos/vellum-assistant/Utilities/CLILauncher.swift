import Foundation
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "CLILauncher")

/// Launches CLI commands for remote hatching during onboarding.
@MainActor
final class CLILauncher {
    struct RemoteHatchConfig: Sendable {
        let remote: String
        let gcpProjectId: String
        let gcpZone: String
        let gcpServiceAccountKey: String
        let awsRoleArn: String
        let sshHost: String
        let sshUser: String
        let sshPrivateKey: String
        let anthropicApiKey: String
    }

    func runRemoteHatch(config: RemoteHatchConfig, onLine: @escaping @Sendable (String) -> Void) async throws {
        let cliPath = Bundle.main.bundlePath + "/Contents/MacOS/vellum-cli"

        var args = ["hatch", "--name", "vellum-assistant"]

        if config.remote != "local" {
            args += ["--remote", config.remote]
        }

        if !config.gcpProjectId.isEmpty {
            args += ["--gcp-project-id", config.gcpProjectId]
        }
        if !config.gcpZone.isEmpty {
            args += ["--gcp-zone", config.gcpZone]
        }
        if !config.awsRoleArn.isEmpty {
            args += ["--aws-role-arn", config.awsRoleArn]
        }
        if !config.sshHost.isEmpty {
            args += ["--ssh-host", config.sshHost]
        }
        if !config.sshUser.isEmpty {
            args += ["--ssh-user", config.sshUser]
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: cliPath)
        process.arguments = args

        var env = ProcessInfo.processInfo.environment
        if !config.anthropicApiKey.isEmpty {
            env["ANTHROPIC_API_KEY"] = config.anthropicApiKey
        }
        if !config.gcpServiceAccountKey.isEmpty {
            env["GCP_SERVICE_ACCOUNT_KEY"] = config.gcpServiceAccountKey
        }
        if !config.sshPrivateKey.isEmpty {
            env["SSH_PRIVATE_KEY"] = config.sshPrivateKey
        }
        process.environment = env

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        log.info("Starting remote hatch: \(args.joined(separator: " "))")

        try process.run()

        let handle = pipe.fileHandleForReading
        let sendLine = onLine

        // Read output line by line in a detached task
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            Task.detached {
                let data = handle.readDataToEndOfFile()
                if let output = String(data: data, encoding: .utf8) {
                    for line in output.components(separatedBy: .newlines) where !line.isEmpty {
                        await MainActor.run { sendLine(line) }
                    }
                }
                process.waitUntilExit()
                if process.terminationStatus == 0 {
                    continuation.resume()
                } else {
                    continuation.resume(throwing: NSError(
                        domain: "CLILauncher",
                        code: Int(process.terminationStatus),
                        userInfo: [NSLocalizedDescriptionKey: "CLI exited with code \(process.terminationStatus)"]
                    ))
                }
            }
        }
    }
}
