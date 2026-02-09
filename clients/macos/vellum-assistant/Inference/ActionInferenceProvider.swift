import Foundation
import CoreGraphics

protocol ActionInferenceProvider {
    func infer(
        axTree: String?,
        screenshot: Data?,
        screenSize: CGSize,
        task: String,
        history: [ActionRecord],
        elements: [AXElement]?
    ) async throws -> AgentAction
}
