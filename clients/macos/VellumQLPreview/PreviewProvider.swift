import QuickLookUI
import Foundation
import UniformTypeIdentifiers

/// Quick Look preview provider for .vellum bundle files.
///
/// Renders a rich HTML preview showing app icon, name, description,
/// version, creator, date, and file size extracted from the ZIP-based
/// .vellum bundle.
class PreviewProvider: QLPreviewProvider, QLPreviewingController {

    struct Manifest {
        var name: String?
        var description: String?
        var icon: String?
        var createdAt: String?
        var createdBy: String?
        var version: String?
        var capabilities: [String]?
        var contentId: String?
    }

    func providePreview(
        for request: QLFilePreviewRequest,
        completionHandler handler: @escaping (QLPreviewReply?, Error?) -> Void
    ) {
        let fileURL = request.fileURL

        // Extract manifest.json
        let manifest = extractManifest(from: fileURL)

        // Extract icon.png as base64
        let iconBase64: String?
        if let iconData = extractFileFromZip(at: fileURL, entryName: "icon.png") {
            iconBase64 = iconData.base64EncodedString()
        } else {
            iconBase64 = nil
        }

        // Get file size
        let fileSize = formattedFileSize(for: fileURL)

        // Build HTML
        let html = buildHTML(
            manifest: manifest,
            iconBase64: iconBase64,
            fileSize: fileSize
        )

        let htmlData = Data(html.utf8)
        let reply = QLPreviewReply(
            dataOfContentType: UTType.html,
            contentSize: CGSize(width: 600, height: 400)
        ) { _ in
            return htmlData
        }
        handler(reply, nil)
    }

    // MARK: - ZIP Extraction

    /// Extracts a single file entry from a ZIP archive using the `unzip` command.
    private func extractFileFromZip(at url: URL, entryName: String) -> Data? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        process.arguments = ["-p", url.path, entryName]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return nil
        }

        guard process.terminationStatus == 0 else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return data.isEmpty ? nil : data
    }

    // MARK: - Manifest Parsing

    private func extractManifest(from url: URL) -> Manifest {
        var manifest = Manifest()
        guard let data = extractFileFromZip(at: url, entryName: "manifest.json"),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return manifest
        }

        manifest.name = json["name"] as? String
        manifest.description = json["description"] as? String
        manifest.icon = json["icon"] as? String
        manifest.createdAt = json["created_at"] as? String
        manifest.createdBy = json["created_by"] as? String
        manifest.version = json["version"] as? String
        manifest.contentId = json["content_id"] as? String

        if let caps = json["capabilities"] as? [String] {
            manifest.capabilities = caps
        }

        return manifest
    }

    // MARK: - File Size

    private func formattedFileSize(for url: URL) -> String {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = attrs[.size] as? UInt64 else {
            return "Unknown size"
        }

        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(size))
    }

    // MARK: - Date Formatting

    private func formattedDate(_ isoString: String?) -> String? {
        guard let isoString = isoString, !isoString.isEmpty else { return nil }

        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        // Try with fractional seconds first, then without
        var date = isoFormatter.date(from: isoString)
        if date == nil {
            isoFormatter.formatOptions = [.withInternetDateTime]
            date = isoFormatter.date(from: isoString)
        }

        guard let parsedDate = date else { return isoString }

        let displayFormatter = DateFormatter()
        displayFormatter.dateStyle = .long
        displayFormatter.timeStyle = .short
        return displayFormatter.string(from: parsedDate)
    }

    // MARK: - HTML Generation

    private func escapeHTML(_ string: String) -> String {
        string
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }

    private func buildHTML(
        manifest: Manifest,
        iconBase64: String?,
        fileSize: String
    ) -> String {
        let name = escapeHTML(manifest.name ?? "Untitled App")
        let description = manifest.description.map { escapeHTML($0) }
        let version = manifest.version.map { escapeHTML($0) }
        let createdBy = manifest.createdBy.map { escapeHTML($0) }
        let formattedCreatedAt = formattedDate(manifest.createdAt)
        let emoji = manifest.icon.map { escapeHTML($0) }

        // Build icon HTML: use base64 image if available, otherwise emoji or placeholder
        let iconHTML: String
        if let base64 = iconBase64 {
            iconHTML = """
                <img src="data:image/png;base64,\(base64)" \
                class="app-icon" alt="\(name) icon" />
                """
        } else if let emoji = emoji, !emoji.isEmpty {
            iconHTML = """
                <div class="app-icon-emoji">\(emoji)</div>
                """
        } else {
            iconHTML = """
                <div class="app-icon-placeholder">\(String(name.prefix(1)))</div>
                """
        }

        // Build metadata rows
        var metaRows = ""
        if let version = version {
            metaRows += "<div class=\"meta-row\"><span class=\"meta-label\">Version</span><span class=\"meta-value\">\(version)</span></div>"
        }
        if let createdBy = createdBy {
            metaRows += "<div class=\"meta-row\"><span class=\"meta-label\">Creator</span><span class=\"meta-value\">\(createdBy)</span></div>"
        }
        if let dateStr = formattedCreatedAt {
            metaRows += "<div class=\"meta-row\"><span class=\"meta-label\">Created</span><span class=\"meta-value\">\(escapeHTML(dateStr))</span></div>"
        }
        metaRows += "<div class=\"meta-row\"><span class=\"meta-label\">Size</span><span class=\"meta-value\">\(escapeHTML(fileSize))</span></div>"

        // Build capabilities
        var capsHTML = ""
        if let caps = manifest.capabilities, !caps.isEmpty {
            let tags = caps.map { "<span class=\"cap-tag\">\(escapeHTML($0))</span>" }.joined()
            capsHTML = "<div class=\"capabilities\">\(tags)</div>"
        }

        return """
        <!DOCTYPE html>
        <html>
        <head>
        <meta charset="utf-8">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif;
                background: #1a1a2e;
                color: #e2e8f0;
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
                padding: 40px 20px;
            }
            .container {
                text-align: center;
                max-width: 480px;
                width: 100%;
            }
            .app-icon {
                width: 96px;
                height: 96px;
                border-radius: 22px;
                object-fit: cover;
                margin-bottom: 20px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            }
            .app-icon-emoji {
                font-size: 72px;
                line-height: 96px;
                height: 96px;
                margin-bottom: 20px;
            }
            .app-icon-placeholder {
                width: 96px;
                height: 96px;
                border-radius: 22px;
                background: linear-gradient(135deg, #6366f1, #8b5cf6);
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font-size: 40px;
                font-weight: 700;
                color: white;
                margin-bottom: 20px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            }
            .app-name {
                font-size: 28px;
                font-weight: 700;
                color: #f8fafc;
                margin-bottom: 8px;
                letter-spacing: -0.02em;
            }
            .app-description {
                font-size: 15px;
                color: #94a3b8;
                line-height: 1.5;
                margin-bottom: 24px;
                max-width: 400px;
                margin-left: auto;
                margin-right: auto;
            }
            .meta-section {
                background: rgba(255, 255, 255, 0.05);
                border-radius: 12px;
                padding: 16px 20px;
                margin-bottom: 16px;
            }
            .meta-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 6px 0;
            }
            .meta-row + .meta-row {
                border-top: 1px solid rgba(255, 255, 255, 0.06);
            }
            .meta-label {
                font-size: 13px;
                color: #64748b;
                font-weight: 500;
            }
            .meta-value {
                font-size: 13px;
                color: #cbd5e1;
                font-weight: 500;
            }
            .capabilities {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                justify-content: center;
                margin-top: 4px;
            }
            .cap-tag {
                font-size: 11px;
                color: #a78bfa;
                background: rgba(139, 92, 246, 0.15);
                padding: 4px 10px;
                border-radius: 999px;
                font-weight: 500;
            }
            .badge {
                display: inline-block;
                font-size: 11px;
                color: #94a3b8;
                background: rgba(255, 255, 255, 0.05);
                padding: 4px 12px;
                border-radius: 999px;
                margin-top: 12px;
                letter-spacing: 0.05em;
                text-transform: uppercase;
                font-weight: 600;
            }
        </style>
        </head>
        <body>
        <div class="container">
            \(iconHTML)
            <div class="app-name">\(name)</div>
            \(description.map { "<div class=\"app-description\">\($0)</div>" } ?? "")
            <div class="meta-section">
                \(metaRows)
            </div>
            \(capsHTML)
            <div class="badge">Vellum App Bundle</div>
        </div>
        </body>
        </html>
        """
    }
}
