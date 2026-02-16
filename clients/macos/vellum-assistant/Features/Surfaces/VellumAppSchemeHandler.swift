import Foundation
@preconcurrency import WebKit
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "VellumAppScheme")

/// Custom URL scheme handler for `vellumapp://{uuid}/path` URLs.
/// Maps requests to files in the sandbox directory for shared apps.
final class VellumAppSchemeHandler: NSObject, WKURLSchemeHandler {

    /// The scheme this handler manages.
    static let scheme = "vellumapp"

    /// Base directory for shared app content.
    private let baseDirectory: URL

    /// Base directory for user-created app content.
    static var userAppsDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".vellum/workspace/data/apps")
    }

    init(baseDirectory: URL = BundleSandbox.sharedAppsDirectory) {
        self.baseDirectory = baseDirectory
    }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            fail(urlSchemeTask, statusCode: 400, message: "No URL in request")
            return
        }

        // Parse: vellumapp://{uuid}/path/to/file
        guard let host = url.host, !host.isEmpty else {
            fail(urlSchemeTask, statusCode: 400, message: "No UUID host in URL")
            return
        }

        let uuid = host
        let resourcePath = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path

        // Resolve file path — try user apps directory first, then shared apps.
        let candidateDirs = [
            Self.userAppsDirectory.appendingPathComponent(uuid),
            baseDirectory.appendingPathComponent(uuid)
        ]

        func resolveFile(in appDir: URL) -> (path: String, appDirPath: String)? {
            let filePath = resourcePath.isEmpty
                ? appDir
                : appDir.appendingPathComponent(resourcePath)
            let resolvedPath = filePath.standardizedFileURL.path
            let appDirPath = appDir.standardizedFileURL.path
            // Security: ensure the resolved path is within the app directory.
            guard resolvedPath == appDirPath || resolvedPath.hasPrefix(appDirPath + "/") else {
                return nil
            }
            guard FileManager.default.fileExists(atPath: resolvedPath) else {
                return nil
            }
            return (resolvedPath, appDirPath)
        }

        guard let resolved = candidateDirs.lazy.compactMap({ resolveFile(in: $0) }).first else {
            // Check if any candidate had a path traversal issue
            for appDir in candidateDirs {
                let filePath = resourcePath.isEmpty ? appDir : appDir.appendingPathComponent(resourcePath)
                let resolvedPath = filePath.standardizedFileURL.path
                let appDirPath = appDir.standardizedFileURL.path
                if resolvedPath != appDirPath && !resolvedPath.hasPrefix(appDirPath + "/") {
                    log.error("Path traversal attempt: \(resolvedPath) outside \(appDirPath)")
                    fail(urlSchemeTask, statusCode: 403, message: "Access denied")
                    return
                }
            }
            fail(urlSchemeTask, statusCode: 404, message: "File not found: \(resourcePath)")
            return
        }

        let resolvedPath = resolved.path
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: resolvedPath)) else {
            fail(urlSchemeTask, statusCode: 500, message: "Failed to read file")
            return
        }

        let mimeType = Self.mimeType(for: resolvedPath)
        let response = URLResponse(
            url: url,
            mimeType: mimeType,
            expectedContentLength: data.count,
            textEncodingName: mimeType.hasPrefix("text/") ? "utf-8" : nil
        )

        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // Nothing to cancel for synchronous file reads
    }

    // MARK: - Helpers

    private func fail(_ task: WKURLSchemeTask, statusCode: Int, message: String) {
        log.error("Scheme handler error (\(statusCode)): \(message)")
        let response = HTTPURLResponse(
            url: task.request.url ?? URL(string: "vellumapp://error")!,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/plain"]
        )!
        task.didReceive(response)
        task.didReceive(Data(message.utf8))
        task.didFinish()
    }

    /// Determine MIME type from file extension.
    static func mimeType(for path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "html", "htm":
            return "text/html"
        case "css":
            return "text/css"
        case "js", "mjs":
            return "application/javascript"
        case "json":
            return "application/json"
        case "png":
            return "image/png"
        case "jpg", "jpeg":
            return "image/jpeg"
        case "gif":
            return "image/gif"
        case "svg":
            return "image/svg+xml"
        case "ico":
            return "image/x-icon"
        case "woff":
            return "font/woff"
        case "woff2":
            return "font/woff2"
        case "ttf":
            return "font/ttf"
        case "otf":
            return "font/otf"
        case "webp":
            return "image/webp"
        case "mp3":
            return "audio/mpeg"
        case "mp4":
            return "video/mp4"
        case "webm":
            return "video/webm"
        case "xml":
            return "application/xml"
        case "txt":
            return "text/plain"
        case "wasm":
            return "application/wasm"
        default:
            return "application/octet-stream"
        }
    }
}
