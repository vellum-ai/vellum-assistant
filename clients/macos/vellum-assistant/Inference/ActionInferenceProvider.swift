import Foundation
import CoreGraphics

protocol ActionInferenceProvider {
    func infer(
        axTree: String?,
        previousAXTree: String?,
        screenshot: Data?,
        screenSize: CGSize,
        task: String,
        history: [ActionRecord],
        elements: [AXElement]?
    ) async throws -> AgentAction
}
