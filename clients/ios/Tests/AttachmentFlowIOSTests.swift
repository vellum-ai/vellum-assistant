import XCTest
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif
@testable import VellumAssistantShared

/// Tests for the attachment flow from the iOS perspective.
/// Exercises attachment addition, removal, limits, sending with attachments,
/// and the ChatAttachment model behaviors.
/// Note: Tests run on the host (macOS) so platform-specific image APIs use #if guards.
@MainActor
final class AttachmentFlowIOSTests: XCTestCase {

    private var mockClient: MockDaemonClient!
    private var viewModel: ChatViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockDaemonClient()
        mockClient.isConnected = true
        viewModel = ChatViewModel(daemonClient: mockClient, eventStreamClient: mockClient.eventStreamClient)
    }

    override func tearDown() {
        viewModel = nil
        mockClient = nil
        super.tearDown()
    }

    // MARK: - Attachment Constants

    func testMaxImageSizeConstant() {
        XCTAssertEqual(ChatViewModel.maxImageSize, 4 * 1024 * 1024, "Max image size should be 4 MB")
    }

    // MARK: - Pending Attachments

    func testInitialPendingAttachmentsEmpty() {
        XCTAssertTrue(viewModel.pendingAttachments.isEmpty)
    }

    func testRemoveAttachmentById() {
        let attachment = makeDummyAttachment(id: "att-1", filename: "file.txt")
        viewModel.pendingAttachments.append(attachment)
        XCTAssertEqual(viewModel.pendingAttachments.count, 1)

        viewModel.removeAttachment(id: "att-1")
        XCTAssertEqual(viewModel.pendingAttachments.count, 0)
    }

    func testRemoveNonexistentAttachmentIsNoOp() {
        let attachment = makeDummyAttachment(id: "att-1", filename: "file.txt")
        viewModel.pendingAttachments.append(attachment)

        viewModel.removeAttachment(id: "nonexistent")
        XCTAssertEqual(viewModel.pendingAttachments.count, 1, "Should not remove anything for wrong ID")
    }

    func testRemoveSpecificAttachmentLeavesOthers() {
        let att1 = makeDummyAttachment(id: "att-1", filename: "file1.txt")
        let att2 = makeDummyAttachment(id: "att-2", filename: "file2.txt")
        let att3 = makeDummyAttachment(id: "att-3", filename: "file3.txt")
        viewModel.pendingAttachments = [att1, att2, att3]

        viewModel.removeAttachment(id: "att-2")
        XCTAssertEqual(viewModel.pendingAttachments.count, 2)
        XCTAssertEqual(viewModel.pendingAttachments[0].id, "att-1")
        XCTAssertEqual(viewModel.pendingAttachments[1].id, "att-3")
    }

    // MARK: - Send with Attachments

    func testSendMessageWithAttachmentsClearsAttachments() {
        viewModel.conversationId = "sess-att"

        let attachment = makeDummyAttachment(id: "att-1", filename: "test.png")
        viewModel.pendingAttachments = [attachment]

        viewModel.inputText = "Check this image"
        viewModel.sendMessage()

        XCTAssertTrue(viewModel.pendingAttachments.isEmpty, "Sending should clear pending attachments")
    }

    func testSendMessageWithOnlyAttachmentsNoText() {
        viewModel.conversationId = "sess-att-only"

        let attachment = makeDummyAttachment(id: "att-1", filename: "doc.pdf")
        viewModel.pendingAttachments = [attachment]

        viewModel.inputText = ""
        viewModel.sendMessage()

        // With only attachments (no text), the message should still send
        XCTAssertTrue(viewModel.pendingAttachments.isEmpty)
        XCTAssertEqual(viewModel.messages.count, 1)
    }

    func testSendMessageIncludesAttachmentsInUserMessage() {
        viewModel.conversationId = "sess-att-msg"

        let attachment = makeDummyAttachment(id: "att-1", filename: "photo.jpg")
        viewModel.pendingAttachments = [attachment]

        viewModel.inputText = "Here is a photo"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].attachments.count, 1)
        XCTAssertEqual(viewModel.messages[0].attachments[0].filename, "photo.jpg")
    }

    // MARK: - ChatAttachment Model

    func testChatAttachmentIdentifiable() {
        let att = makeDummyAttachment(id: "unique-id", filename: "test.txt")
        XCTAssertEqual(att.id, "unique-id")
    }

    func testChatAttachmentLazyLoadDetection() {
        // Regular attachment (has data, no sizeBytes)
        let regular = makeDummyAttachment(id: "reg", filename: "file.txt")
        XCTAssertFalse(regular.isLazyLoad)

        // Lazy-load attachment (empty data, has sizeBytes)
        let lazy = ChatAttachment(
            id: "lazy",
            filename: "bigfile.bin",
            mimeType: "application/octet-stream",
            data: "",
            thumbnailData: nil,
            dataLength: 0,
            sizeBytes: 50_000_000,
            thumbnailImage: nil
        )
        XCTAssertTrue(lazy.isLazyLoad)
    }

    func testChatAttachmentNotLazyWhenEmptyDataAndNoSizeBytes() {
        let att = ChatAttachment(
            id: "empty",
            filename: "empty.txt",
            mimeType: "text/plain",
            data: "",
            thumbnailData: nil,
            dataLength: 0,
            sizeBytes: nil,
            thumbnailImage: nil
        )
        XCTAssertFalse(att.isLazyLoad, "Should not be lazy-load without sizeBytes")
    }

    // MARK: - Image Attachment via Raw Data

    func testAddAttachmentFromImageData() async throws {
        let pngData = makeMinimalPNGData()

        viewModel.addAttachment(imageData: pngData, filename: "Screenshot.png")

        // addAttachment(imageData:) processes the image asynchronously via a
        // MainActor Task. Yield the main actor so the continuation can run —
        // XCTNSPredicateExpectation's wait(for:) pumps the run loop but doesn't
        // yield the cooperative executor, causing the Task to never complete.
        for _ in 0..<50 {
            if !viewModel.pendingAttachments.isEmpty { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }

        XCTAssertEqual(viewModel.pendingAttachments.count, 1)
        guard let first = viewModel.pendingAttachments.first else {
            XCTFail("Expected one pending attachment")
            return
        }
        XCTAssertEqual(first.filename, "Screenshot.png")
        XCTAssertEqual(first.mimeType, "image/png")
    }

    // MARK: - Thumbnail Generation

    func testGenerateThumbnailReturnsDataForValidImage() {
        let pngData = makeMinimalPNGData()
        let thumbnail = ChatViewModel.generateThumbnail(from: pngData, maxDimension: 120)
        XCTAssertNotNil(thumbnail, "Should generate a thumbnail from valid PNG data")
    }

    func testGenerateThumbnailReturnsNilForInvalidData() {
        let invalidData = Data([0x00, 0x01, 0x02, 0x03])
        let thumbnail = ChatViewModel.generateThumbnail(from: invalidData, maxDimension: 120)
        XCTAssertNil(thumbnail, "Should return nil for non-image data")
    }

    // MARK: - Image Compression

    func testCompressImageIfNeededReturnsFalseForSmallImage() {
        let smallData = makeMinimalPNGData()
        let (resultData, wasCompressed) = ChatViewModel.compressImageIfNeeded(data: smallData, maxSize: 4 * 1024 * 1024)
        XCTAssertFalse(wasCompressed, "Small image should not need compression")
        XCTAssertEqual(resultData, smallData, "Data should be unchanged")
    }

    // MARK: - Helpers

    private func makeDummyAttachment(id: String, filename: String) -> ChatAttachment {
        ChatAttachment(
            id: id,
            filename: filename,
            mimeType: "text/plain",
            data: "SGVsbG8=",
            thumbnailData: nil,
            dataLength: 8,
            thumbnailImage: nil
        )
    }

    /// Create a minimal valid 10x10 red PNG for testing.
    /// Uses platform-appropriate APIs since tests run on the host (macOS).
    private func makeMinimalPNGData() -> Data {
        #if os(macOS)
        let size = NSSize(width: 10, height: 10)
        let image = NSImage(size: size)
        image.lockFocus()
        NSColor.red.setFill()
        NSRect(origin: .zero, size: size).fill()
        image.unlockFocus()
        guard let tiffData = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffData),
              let png = bitmap.representation(using: .png, properties: [:]) else {
            return Data()
        }
        return png
        #elseif os(iOS)
        let size = CGSize(width: 10, height: 10)
        UIGraphicsBeginImageContextWithOptions(size, false, 1.0)
        UIColor.red.setFill()
        UIRectFill(CGRect(origin: .zero, size: size))
        let image = UIGraphicsGetImageFromCurrentImageContext()
        UIGraphicsEndImageContext()
        return image?.pngData() ?? Data()
        #else
        return Data()
        #endif
    }
}
