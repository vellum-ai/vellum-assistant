import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HostFile")

// MARK: - Host File Proxy Execution

extension HTTPTransport {

    #if os(macOS)
    /// Execute a host file request locally and post the result back to the daemon.
    /// Dispatches by operation: read, write, or edit.
    func executeHostFileRequest(_ request: HostFileRequest) {
        Task.detached {
            let result: HostFileResultPayload

            do {
                switch request.operation {
                case "read":
                    let content = try Self.readFile(
                        path: request.path,
                        offset: request.offset,
                        limit: request.limit
                    )
                    result = HostFileResultPayload(
                        requestId: request.requestId,
                        content: content,
                        isError: false
                    )

                case "write":
                    let message = try Self.writeFile(
                        path: request.path,
                        content: request.content ?? ""
                    )
                    result = HostFileResultPayload(
                        requestId: request.requestId,
                        content: message,
                        isError: false
                    )

                case "edit":
                    let message = try Self.editFile(
                        path: request.path,
                        oldString: request.oldString ?? "",
                        newString: request.newString ?? "",
                        replaceAll: request.replaceAll ?? false
                    )
                    result = HostFileResultPayload(
                        requestId: request.requestId,
                        content: message,
                        isError: false
                    )

                default:
                    result = HostFileResultPayload(
                        requestId: request.requestId,
                        content: "Unknown file operation: \(request.operation)",
                        isError: true
                    )
                }
            } catch {
                result = HostFileResultPayload(
                    requestId: request.requestId,
                    content: "File operation failed: \(error.localizedDescription)",
                    isError: true
                )
            }

            log.debug("Host file completed — requestId=\(request.requestId, privacy: .public) op=\(request.operation, privacy: .public) isError=\(result.isError)")
            _ = await HostProxyClient().postFileResult(result)
        }
    }

    // MARK: - File Operations

    /// Read a file and return its content formatted with line numbers.
    /// Matches the daemon's `FileSystemOps.readFileSafe` output format.
    private nonisolated static func readFile(path: String, offset: Int?, limit: Int?) throws -> String {
        let fileContent = try String(contentsOfFile: path, encoding: .utf8)
        var lines = fileContent.components(separatedBy: "\n")

        // Apply offset (1-based line number)
        let startIndex = max((offset ?? 1) - 1, 0)
        if startIndex > 0 && startIndex < lines.count {
            lines = Array(lines[startIndex...])
        } else if startIndex >= lines.count {
            return ""
        }

        // Apply limit
        if let limit, limit > 0, limit < lines.count {
            lines = Array(lines[..<limit])
        }

        // Format with line numbers matching daemon output format:
        // 6-char right-padded line number + 2 spaces + content
        // e.g. "     1  line content"
        let lineNumberStart = max(offset ?? 1, 1)
        let formatted = lines.enumerated().map { index, line in
            let lineNumber = lineNumberStart + index
            let padded = String(repeating: " ", count: max(0, 6 - String(lineNumber).count)) + "\(lineNumber)"
            return "\(padded)  \(line)"
        }

        return formatted.joined(separator: "\n")
    }

    /// Write content to a file, creating parent directories as needed.
    private nonisolated static func writeFile(path: String, content: String) throws -> String {
        let fileURL = URL(fileURLWithPath: path)
        let parentDir = fileURL.deletingLastPathComponent().path

        // Create parent directories if needed
        try FileManager.default.createDirectory(
            atPath: parentDir,
            withIntermediateDirectories: true,
            attributes: nil
        )

        try content.data(using: .utf8)?.write(to: fileURL)
        return "Successfully wrote to \(path)"
    }

    /// Edit a file by finding and replacing a string.
    /// If `replaceAll` is true, replaces all occurrences.
    /// If `replaceAll` is false, verifies exactly one match exists.
    private nonisolated static func editFile(path: String, oldString: String, newString: String, replaceAll: Bool) throws -> String {
        guard oldString != newString else {
            throw FileOperationError.sameStrings
        }

        var content = try String(contentsOfFile: path, encoding: .utf8)

        if replaceAll {
            let count = content.components(separatedBy: oldString).count - 1
            guard count > 0 else {
                throw FileOperationError.noMatch
            }
            content = content.replacingOccurrences(of: oldString, with: newString)
            try content.data(using: .utf8)?.write(to: URL(fileURLWithPath: path))
            return "Successfully replaced \(count) occurrence\(count == 1 ? "" : "s") in \(path)"
        } else {
            // Count occurrences
            let count = content.components(separatedBy: oldString).count - 1
            guard count > 0 else {
                throw FileOperationError.noMatch
            }
            guard count == 1 else {
                throw FileOperationError.multipleMatches(count)
            }
            content = content.replacingOccurrences(of: oldString, with: newString)
            try content.data(using: .utf8)?.write(to: URL(fileURLWithPath: path))
            return "Successfully edited \(path)"
        }
    }

    /// Errors specific to host file operations.
    private enum FileOperationError: LocalizedError {
        case noMatch
        case multipleMatches(Int)
        case sameStrings

        var errorDescription: String? {
            switch self {
            case .noMatch:
                return "old_string not found in file"
            case .multipleMatches(let count):
                return "old_string found \(count) times in file — must be unique (use replace_all to replace all occurrences)"
            case .sameStrings:
                return "old_string and new_string are identical — no changes needed"
            }
        }
    }
    #endif
}
