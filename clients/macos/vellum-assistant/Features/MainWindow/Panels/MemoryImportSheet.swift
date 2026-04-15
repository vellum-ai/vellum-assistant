import SwiftUI
import VellumAssistantShared

struct MemoryImportSheet: View {
    let assistantName: String
    let onDismiss: () -> Void
    var onSubmit: ((String) -> Void)?

    @State private var pastedText: String = ""
    @State private var isSubmitting = false

    static let importPrompt = """
        I want to save a complete backup of everything you know about me. Write a comprehensive profile covering ALL knowledge you have — stored memories, contextual knowledge, inferred patterns, and anything you've picked up from our conversations, even if it's not formally saved as a "memory."

        Draw from every internal source available to you — memory entries, session context, conversation history, working notes, inferred traits, and any structured data you hold about me.

        Before writing the profile, internally enumerate all known facts about me and ensure each one is either included or explicitly ruled out. Do not rely on recall alone — perform a completeness check.

        For timeless information (who I am, how I think, my preferences), include ALL persistent identity signals — including personality frameworks, symbolic systems, behavioral patterns, inferred traits, and any structured metadata about me — even if they were only mentioned once or are rarely referenced. Do not prioritize based on usage frequency. If something exists in memory or context, it must be included regardless of how often it comes up.

        For time-bound information (projects, events, stories), only include things from the last 6 months. Skip anything older unless it's still actively relevant.

        Cover each of these areas (skip any that don't apply):

        **Identity & background**: Name, location, family, relationships, education, languages, personal interests, personality frameworks, symbolic systems, and anything else about who I am as a person.

        **Career & role**: My current role, company, industry, skills, and professional goals.

        **How I think and communicate**: Communication style, tone preferences, formatting preferences, how I like to receive information, how I make decisions, and any patterns you've noticed.

        **Preferences & instructions**: Things I've told you to always do, never do, or change about your behavior. Also include preferences I haven't explicitly stated but that you've observed — topics I gravitate toward, how I like things structured, what I value.

        **Personality & inferred traits**: Personality traits, values, recurring themes, tendencies, or behavioral patterns you've observed — even if I never explicitly stated them. Include interpretations and connections you've drawn, not just raw facts.

        **Current projects & context** (last 6 months only): What I'm actively working on. Include project names, what they do, current status, and key decisions. Skip anything older unless it's still actively relevant.

        **Other**: Hobbies, tastes, opinions, inside references, structured data you hold about me, or anything else meaningful.

        Important rules:
        - Do NOT compress or summarize aggressively — include full detail
        - Do NOT collapse structured context into single-line summaries — expand them fully
        - Do NOT omit any identity-related information due to perceived relevance, importance, or frequency of use. If it exists, include it.
        - Use full sentences and be specific — names, dates, numbers, details
        """

    var body: some View {
        VModal(title: "Import memory to \(assistantName)") {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                // Step 1: Copy prompt
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Step 1")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    Text("Copy this prompt and send it to the other AI provider")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)

                    ZStack(alignment: .bottomTrailing) {
                        ScrollView {
                            Text(Self.importPrompt)
                                .font(VFont.bodySmallDefault)
                                .foregroundStyle(VColor.contentSecondary)
                                .textSelection(.enabled)
                                .padding(VSpacing.sm)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(height: 160)
                        .background(VColor.surfaceActive)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .stroke(VColor.borderBase, lineWidth: 1)
                        )

                        VCopyButton(text: Self.importPrompt, size: .compact)
                            .padding(VSpacing.sm)
                    }
                }

                // Step 2: Paste response
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Step 2")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    Text("Paste the response below")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)

                    TextEditor(text: $pastedText)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentDefault)
                        .scrollContentBackground(.hidden)
                        .padding(VSpacing.sm)
                        .background(VColor.surfaceActive)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .stroke(VColor.borderBase, lineWidth: 1)
                        )
                        .frame(minHeight: 140)
                        .overlay(alignment: .topLeading) {
                            if pastedText.isEmpty {
                                Text("Paste the AI's response here...")
                                    .font(VFont.bodyMediumLighter)
                                    .foregroundStyle(VColor.contentTertiary)
                                    .padding(VSpacing.sm)
                                    .padding(.top, 1)
                                    .padding(.leading, 5)
                                    .allowsHitTesting(false)
                            }
                        }
                }
            }
        } footer: {
            HStack {
                Spacer()
                VButton(label: "Cancel", style: .outlined) {
                    onDismiss()
                }
                VButton(
                    label: isSubmitting ? "Adding..." : "Add to memory",
                    style: .primary,
                    isDisabled: pastedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSubmitting || onSubmit == nil
                ) {
                    guard let onSubmit else { return }
                    isSubmitting = true
                    onSubmit(pastedText)
                    isSubmitting = false
                    onDismiss()
                }
            }
        }
        .frame(width: 560)
    }
}
