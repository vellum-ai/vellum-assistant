import Foundation
import PDFKit

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
        let mimeType = Self.mimeType(for: url.pathExtension)
        if unsupportedOfficeMimeTypes.contains(mimeType) {
            throw NSError(domain: "TaskAttachment", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "\(fileName) is not supported yet on macOS for text extraction. Please convert it to PDF or plain text."
            ])
        }
        guard allowedMimeTypes.contains(mimeType) else {
            throw NSError(domain: "TaskAttachment", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "\(fileName) has an unsupported file type."
            ])
        }
        let kind: TaskAttachmentKind = mimeType.hasPrefix("image/") ? .image : .document
        let maxBytes = kind == .image ? maxImageBytes : maxDocumentBytes

        if let resourceValues = try? url.resourceValues(forKeys: [.fileSizeKey]),
           let declaredSize = resourceValues.fileSize,
           declaredSize > maxBytes {
            throw NSError(domain: "TaskAttachment", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "\(fileName) exceeds size limit for \(kind.rawValue) attachments."
            ])
        }

        let data = try Data(contentsOf: url)

        guard data.count <= maxBytes else {
            throw NSError(domain: "TaskAttachment", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "\(fileName) exceeds size limit for \(kind.rawValue) attachments."
            ])
        }

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
}

struct TaskSubmission {
    let task: String
    let attachments: [TaskAttachment]
}
