import Foundation
import PDFKit
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "TaskAttachment")

enum TaskAttachmentKind: String {
    case image
    case document
}

struct TaskAttachment: Identifiable {
    let id: UUID
    let fileName: String
    let mimeType: String
    let sizeBytes: Int
    let kind: TaskAttachmentKind
    let data: Data
    let extractedText: String?

    static let maxImageBytes = 10 * 1024 * 1024
    static let maxDocumentBytes = 20 * 1024 * 1024
    static let maxExtractedChars = 8_000
    private static let unsupportedOfficeMimeTypes: Set<String> = [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ]
    private static let allowedMimeTypes: Set<String> = [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "application/pdf",
        "text/plain",
        "text/markdown",
        "application/json",
        "text/csv",
    ]

    static func fromFileURL(_ url: URL) throws -> TaskAttachment {
        let fileName = url.lastPathComponent
        let extensionMimeType = Self.mimeType(for: url.pathExtension)
        if unsupportedOfficeMimeTypes.contains(extensionMimeType) {
            throw NSError(domain: "TaskAttachment", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "\(fileName) is not supported yet on macOS for text extraction. Please convert it to PDF or plain text."
            ])
        }
        guard allowedMimeTypes.contains(extensionMimeType) else {
            throw NSError(domain: "TaskAttachment", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "\(fileName) has an unsupported file type."
            ])
        }
        let kind: TaskAttachmentKind = extensionMimeType.hasPrefix("image/") ? .image : .document
        let maxBytes = kind == .image ? maxImageBytes : maxDocumentBytes

        do {
            let resourceValues = try url.resourceValues(forKeys: [.fileSizeKey])
            if let declaredSize = resourceValues.fileSize, declaredSize > maxBytes {
                throw NSError(domain: "TaskAttachment", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "\(fileName) exceeds size limit for \(kind.rawValue) attachments."
                ])
            }
        } catch let error as NSError where error.domain == "TaskAttachment" {
            throw error
        } catch {
            log.warning("Could not read file size for '\(fileName)': \(error)")
        }

        let data = try Data(contentsOf: url)

        guard data.count <= maxBytes else {
            throw NSError(domain: "TaskAttachment", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "\(fileName) exceeds size limit for \(kind.rawValue) attachments."
            ])
        }

        let mimeType = try Self.validateMimeType(fileName: fileName, expectedMimeType: extensionMimeType, data: data)
        let extractedText = kind == .document ? Self.extractText(data: data, mimeType: mimeType) : nil

        return TaskAttachment(
            id: UUID(),
            fileName: fileName,
            mimeType: mimeType,
            sizeBytes: data.count,
            kind: kind,
            data: data,
            extractedText: extractedText
        )
    }

    static func fromPastedImage(_ data: Data, fileName: String = "pasted-image.png", mimeType: String = "image/png") throws -> TaskAttachment {
        guard data.count <= maxImageBytes else {
            throw NSError(domain: "TaskAttachment", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Pasted image exceeds 10MB limit."
            ])
        }

        return TaskAttachment(
            id: UUID(),
            fileName: fileName,
            mimeType: mimeType,
            sizeBytes: data.count,
            kind: .image,
            data: data,
            extractedText: nil
        )
    }

    private static func mimeType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "png":
            return "image/png"
        case "jpg", "jpeg":
            return "image/jpeg"
        case "webp":
            return "image/webp"
        case "gif":
            return "image/gif"
        case "pdf":
            return "application/pdf"
        case "txt":
            return "text/plain"
        case "md", "markdown":
            return "text/markdown"
        case "json":
            return "application/json"
        case "csv":
            return "text/csv"
        case "docx":
            return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        case "xlsx":
            return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        case "pptx":
            return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        default:
            return "application/octet-stream"
        }
    }

    private static func extractText(data: Data, mimeType: String) -> String? {
        let text: String?
        if mimeType == "application/pdf" {
            text = extractPdfText(data: data)
        } else if mimeType.hasPrefix("text/") || mimeType == "application/json" {
            text = String(data: data, encoding: .utf8)
        } else {
            text = nil
        }

        guard let value = text?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        if value.count > maxExtractedChars {
            return String(value.prefix(maxExtractedChars)) + "\n...[truncated]"
        }
        return value
    }

    private static func extractPdfText(data: Data) -> String? {
        guard let document = PDFDocument(data: data) else {
            return nil
        }
        var parts: [String] = []
        for pageIndex in 0..<document.pageCount {
            guard let page = document.page(at: pageIndex), let text = page.string else {
                continue
            }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                parts.append(trimmed)
            }
        }
        if parts.isEmpty {
            return nil
        }
        return parts.joined(separator: "\n\n")
    }

    private static func validateMimeType(fileName: String, expectedMimeType: String, data: Data) throws -> String {
        let detectedBinaryMimeType = detectBinaryMimeType(data)

        if expectedMimeType.hasPrefix("image/") || expectedMimeType == "application/pdf" {
            guard let detectedBinaryMimeType else {
                throw NSError(domain: "TaskAttachment", code: 5, userInfo: [
                    NSLocalizedDescriptionKey: "\(fileName) content does not match expected file type."
                ])
            }
            guard detectedBinaryMimeType == expectedMimeType else {
                throw NSError(domain: "TaskAttachment", code: 5, userInfo: [
                    NSLocalizedDescriptionKey: "\(fileName) content does not match expected file type."
                ])
            }
            return expectedMimeType
        }

        if detectedBinaryMimeType != nil {
            throw NSError(domain: "TaskAttachment", code: 5, userInfo: [
                NSLocalizedDescriptionKey: "\(fileName) content does not match expected file type."
            ])
        }

        guard String(data: data, encoding: .utf8) != nil else {
            throw NSError(domain: "TaskAttachment", code: 5, userInfo: [
                NSLocalizedDescriptionKey: "\(fileName) is not valid UTF-8 text."
            ])
        }

        return expectedMimeType
    }

    private static func detectBinaryMimeType(_ data: Data) -> String? {
        if data.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
            return "image/png"
        }
        if data.starts(with: [0xFF, 0xD8, 0xFF]) {
            return "image/jpeg"
        }
        if data.starts(with: Data("GIF87a".utf8)) || data.starts(with: Data("GIF89a".utf8)) {
            return "image/gif"
        }
        if data.count >= 12,
           data.subdata(in: 0..<4) == Data("RIFF".utf8),
           data.subdata(in: 8..<12) == Data("WEBP".utf8) {
            return "image/webp"
        }
        if data.starts(with: Data("%PDF-".utf8)) {
            return "application/pdf"
        }
        return nil
    }
}
