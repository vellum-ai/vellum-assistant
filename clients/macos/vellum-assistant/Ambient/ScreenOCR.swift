import Foundation
import Vision
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ScreenOCR")

final class ScreenOCR {
    func recognizeText(from jpegData: Data) async -> String {
        await withCheckedContinuation { continuation in
            guard let cgImage = cgImage(from: jpegData) else {
                log.warning("Failed to create CGImage from JPEG data")
                continuation.resume(returning: "")
                return
            }

            let request = VNRecognizeTextRequest { request, error in
                if let error = error {
                    log.warning("OCR error: \(error.localizedDescription)")
                    continuation.resume(returning: "")
                    return
                }

                guard let observations = request.results as? [VNRecognizedTextObservation] else {
                    continuation.resume(returning: "")
                    return
                }

                let text = observations.compactMap { observation in
                    observation.topCandidates(1).first?.string
                }.joined(separator: "\n")

                continuation.resume(returning: text)
            }

            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true

            let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
            do {
                try handler.perform([request])
            } catch {
                log.warning("VNImageRequestHandler failed: \(error.localizedDescription)")
                continuation.resume(returning: "")
            }
        }
    }

    /// Jaccard similarity on word sets — returns 0.0 (completely different) to 1.0 (identical).
    static func similarity(_ a: String, _ b: String) -> Double {
        let wordsA = Set(a.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).map(String.init))
        let wordsB = Set(b.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).map(String.init))

        guard !wordsA.isEmpty || !wordsB.isEmpty else { return 1.0 }

        let intersection = wordsA.intersection(wordsB).count
        let union = wordsA.union(wordsB).count

        return Double(intersection) / Double(union)
    }

    private func cgImage(from jpegData: Data) -> CGImage? {
        guard let dataProvider = CGDataProvider(data: jpegData as CFData),
              let source = CGImageSourceCreateWithDataProvider(dataProvider, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            return nil
        }
        return image
    }
}
