import Foundation
import os

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "RecipeExecutor"
)

// MARK: - Types

struct RecipeContext {
    let assistantName: String
    let homepageURL: String
    var targetRepo: String?
}

struct RecipeProgress {
    let currentStep: Int
    let totalSteps: Int
    let description: String
}

struct RecipeResult {
    let success: Bool
    let credentials: [String: String]
    let error: String?
}

struct ParsedRecipe {
    let name: String
    let phases: [RecipePhase]
    let totalSteps: Int
    let errorRecovery: String
}

struct RecipePhase {
    let title: String
    let steps: [RecipeStep]
}

struct RecipeStep {
    let number: Int
    let title: String
    let body: String
}

// MARK: - RecipeExecutor

@MainActor
final class RecipeExecutor {

    private let daemonClient: DaemonClientProtocol

    init(daemonClient: DaemonClientProtocol) {
        self.daemonClient = daemonClient
    }

    /// Parse a recipe markdown file and execute it via ComputerUseSession.
    func execute(
        recipeName: String,
        context: RecipeContext,
        onProgress: @escaping (RecipeProgress) -> Void
    ) async -> RecipeResult {
        // 1. Load recipe markdown
        guard let markdown = loadRecipeMarkdown(recipeName) else {
            log.error("Recipe not found: \(recipeName)")
            return RecipeResult(success: false, credentials: [:], error: "Recipe '\(recipeName)' not found")
        }

        // 2. Parse into structured recipe
        let recipe = parseRecipe(markdown: markdown, name: recipeName)
        log.info("Parsed recipe '\(recipeName)': \(recipe.totalSteps) steps across \(recipe.phases.count) phases")

        // 3. Interpolate context variables
        let taskPrompt = buildTaskPrompt(recipe: recipe, context: context)

        // 4. Create and run a ComputerUseSession
        let session = ComputerUseSession(
            task: taskPrompt,
            daemonClient: daemonClient,
            maxSteps: max(recipe.totalSteps * 4, 40), // generous headroom; floor of 40 for high-level recipes
            initialDelayMs: 500
        )

        // Monitor session state for progress updates
        let progressTask = Task { [weak session] in
            guard let session else { return }
            var lastStep = 0
            while !Task.isCancelled {
                if case .running(let step, _, let lastAction, _) = session.state {
                    if step != lastStep {
                        lastStep = step
                        // Map session steps to recipe steps (approximate)
                        let recipeStep = min(step, recipe.totalSteps)
                        onProgress(RecipeProgress(
                            currentStep: recipeStep,
                            totalSteps: recipe.totalSteps,
                            description: lastAction
                        ))
                    }
                }
                try? await Task.sleep(nanoseconds: 500_000_000) // 500ms
            }
        }

        onProgress(RecipeProgress(currentStep: 1, totalSteps: recipe.totalSteps, description: "Starting..."))
        await session.run()
        progressTask.cancel()

        // 5. Check result
        switch session.state {
        case .completed(let summary, let steps):
            log.info("Recipe '\(recipeName)' completed in \(steps) steps: \(summary)")
            let credentials = extractCredentials(from: summary)
            onProgress(RecipeProgress(
                currentStep: recipe.totalSteps,
                totalSteps: recipe.totalSteps,
                description: "Done!"
            ))
            return RecipeResult(success: true, credentials: credentials, error: nil)

        case .responded(let answer, let steps):
            log.info("Recipe '\(recipeName)' responded in \(steps) steps: \(answer)")
            let credentials = extractCredentials(from: answer)
            onProgress(RecipeProgress(
                currentStep: recipe.totalSteps,
                totalSteps: recipe.totalSteps,
                description: "Done!"
            ))
            return RecipeResult(success: true, credentials: credentials, error: nil)

        case .failed(let reason):
            log.error("Recipe '\(recipeName)' failed: \(reason)")
            return RecipeResult(success: false, credentials: [:], error: reason)

        case .cancelled:
            log.info("Recipe '\(recipeName)' was cancelled")
            return RecipeResult(success: false, credentials: [:], error: "Cancelled")

        default:
            return RecipeResult(success: false, credentials: [:], error: "Unexpected session state")
        }
    }

    // MARK: - Recipe Loading

    private func loadRecipeMarkdown(_ name: String) -> String? {
        #if SWIFT_PACKAGE
            // SPM builds: recipes are copied into Bundle.module via .copy("Resources/Recipes")
            if let url = Bundle.module.url(forResource: name, withExtension: "md", subdirectory: "Recipes") {
                return try? String(contentsOf: url, encoding: .utf8)
            }
        #endif

        // Xcode builds: individual files are copied flat into the bundle (no subdirectory)
        if let url = Bundle.main.url(forResource: name, withExtension: "md") {
            return try? String(contentsOf: url, encoding: .utf8)
        }

        log.warning("Recipe '\(name)' not found in bundle resources")
        return nil
    }

    // MARK: - Recipe Parsing

    func parseRecipe(markdown: String, name: String) -> ParsedRecipe {
        let lines = markdown.components(separatedBy: "\n")
        var phases: [RecipePhase] = []
        var currentPhaseTitle: String?
        var currentSteps: [RecipeStep] = []
        var currentStepNumber: Int?
        var currentStepTitle: String?
        var currentStepBody: [String] = []
        var errorRecoverySection = ""
        var inErrorRecovery = false
        var inCodeBlock = false
        var stepCounter = 0

        for line in lines {
            // Track code blocks for proper nesting
            if line.hasPrefix("```") {
                inCodeBlock.toggle()
                if inCodeBlock { continue } // skip opening fence
                // closing fence — don't skip, might need to flush
            }

            // Error recovery section
            if line.starts(with: "## Error Recovery") {
                inErrorRecovery = true
                // Flush any pending step
                if let num = currentStepNumber, let title = currentStepTitle {
                    currentSteps.append(RecipeStep(number: num, title: title, body: currentStepBody.joined(separator: "\n")))
                    currentStepNumber = nil
                    currentStepTitle = nil
                    currentStepBody = []
                }
                // Flush any pending phase
                if let phaseTitle = currentPhaseTitle, !currentSteps.isEmpty {
                    phases.append(RecipePhase(title: phaseTitle, steps: currentSteps))
                    currentSteps = []
                }
                continue
            }

            if inErrorRecovery {
                if line.starts(with: "## ") { inErrorRecovery = false } // next section
                else { errorRecoverySection += line + "\n" }
                continue
            }

            // Phase headers (### Phase N: Title)
            if line.starts(with: "### Phase") {
                // Flush pending step
                if let num = currentStepNumber, let title = currentStepTitle {
                    currentSteps.append(RecipeStep(number: num, title: title, body: currentStepBody.joined(separator: "\n")))
                    currentStepNumber = nil
                    currentStepTitle = nil
                    currentStepBody = []
                }
                // Flush pending phase
                if let phaseTitle = currentPhaseTitle, !currentSteps.isEmpty {
                    phases.append(RecipePhase(title: phaseTitle, steps: currentSteps))
                    currentSteps = []
                }
                currentPhaseTitle = String(line.dropFirst(4)) // drop "### "
                continue
            }

            // Step headers (STEP N: Title)
            if let range = line.range(of: #"STEP\s+\d+\w*:\s+(.+)"#, options: .regularExpression) {
                // Extract the title after "STEP N: "
                let stepLine = String(line[range])
                let titleStart = stepLine.range(of: #":\s+"#, options: .regularExpression)
                let title = titleStart.map { String(stepLine[$0.upperBound...]) } ?? stepLine

                // Flush previous step
                if let num = currentStepNumber, let prevTitle = currentStepTitle {
                    currentSteps.append(RecipeStep(number: num, title: prevTitle, body: currentStepBody.joined(separator: "\n")))
                }
                stepCounter += 1
                currentStepNumber = stepCounter
                currentStepTitle = title
                currentStepBody = []
                continue
            }

            // Accumulate step body lines
            if currentStepNumber != nil {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if !trimmed.isEmpty {
                    currentStepBody.append(trimmed)
                }
            }
        }

        // Flush remaining step and phase
        if let num = currentStepNumber, let title = currentStepTitle {
            currentSteps.append(RecipeStep(number: num, title: title, body: currentStepBody.joined(separator: "\n")))
        }
        if let phaseTitle = currentPhaseTitle, !currentSteps.isEmpty {
            phases.append(RecipePhase(title: phaseTitle, steps: currentSteps))
        }

        return ParsedRecipe(
            name: name,
            phases: phases,
            totalSteps: stepCounter,
            errorRecovery: errorRecoverySection.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    // MARK: - Task Prompt Construction

    func buildTaskPrompt(recipe: ParsedRecipe, context: RecipeContext) -> String {
        var prompt = """
        You are setting up an integration for the user. Follow the outline below as a guide,
        adapting to what you see on screen. The steps describe what to accomplish, not exact
        clicks — use your judgement to navigate the UI.

        RECIPE: \(recipe.name)

        """

        for phase in recipe.phases {
            prompt += "\n--- \(phase.title) ---\n\n"
            for step in phase.steps {
                prompt += "STEP \(step.number): \(step.title)\n"
                prompt += step.body + "\n\n"
            }
        }

        if !recipe.errorRecovery.isEmpty {
            prompt += "\n--- ERROR RECOVERY ---\n\(recipe.errorRecovery)\n"
        }

        prompt += """

        IMPORTANT INSTRUCTIONS:
        - Work through each step, taking one action at a time
        - After each action, check the screen to see what changed before continuing
        - If something doesn't look right, consult the error recovery section
        - When all steps are complete, call done() with a summary that includes labeled fields: Username: <github-username>, Repository: <repo-name>, Path: <local-clone-path>
        """

        // Interpolate context variables
        prompt = prompt
            .replacingOccurrences(of: "{assistant-name}", with: context.assistantName)
            .replacingOccurrences(of: "{assistant-homepage-url}", with: context.homepageURL)
        if let repo = context.targetRepo {
            prompt = prompt.replacingOccurrences(of: "{target-repo-name}", with: repo)
            prompt = prompt.replacingOccurrences(of: "{target-repo}", with: repo)
        }

        return prompt
    }

    // MARK: - Credential Extraction

    private func extractCredentials(from summary: String) -> [String: String] {
        var credentials: [String: String] = [:]

        // Look for GitHub username
        if let match = firstCaptureGroup(in: summary, pattern: #"[Uu]sername[\s:]+([^\s,]+)"#) {
            credentials["github_username"] = match
        }

        // Look for cloned repo
        if let match = firstCaptureGroup(in: summary, pattern: #"[Rr]epository[\s:]+([^\s,]+)"#) {
            credentials["cloned_repo"] = match
        }

        // Look for local path
        if let match = firstCaptureGroup(in: summary, pattern: #"[Pp]ath[\s:]+([~/][^\s,]+)"#) {
            credentials["local_path"] = match
        }

        return credentials
    }

    private func firstCaptureGroup(in text: String, pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: text) else {
            return nil
        }
        return String(text[range])
    }
}
