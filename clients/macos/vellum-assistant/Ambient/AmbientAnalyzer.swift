import Foundation

enum AmbientDecision: String, Codable {
    case ignore
    case observe
    case suggest
}

struct AmbientAnalysisResult: Codable {
    let decision: AmbientDecision
    let observation: String?
    let suggestion: String?
    let confidence: Double
    let reasoning: String
}
