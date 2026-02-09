---
title: "Webinar recap: Best practices on building Voice AI agents for patient triaging "
slug: "developing-fast-safe-secure-ai-healthcare-solutions"
shortDescription: "RelyHealth is closing the gap in post-ER care by equipping navigators with AI agents that handle outreach, triage, and documentation—making them 10–15x more effective while ensuring no patient is left behind. In our webinar with CTO Prithvi Narasimhan, we explored how they build AI that is safe, reliable, and auditable: structured data for EHR integration, rigorous evaluation suites to catch edge cases, and observability tools that cut debugging from days to minutes. With Vellum’s workflow builder, evaluation suite, and tracing, ReliHealth can move fast without compromising patient safety—showing how AI can extend human capacity in one of the most high-stakes industries."
dateFrom: "2025-05-21T18:00:00.000Z"
videoRecording: "https://www.youtube.com/embed/L5y5d9SYzd4?si=Ik44aUmSK4E7N23W"
coverImage: "https://cdn.sanity.io/images/ghjnhoi4/production/a938f14ae808c58b39e676e740631170bd8b0712-1280x720.png"
---

## Speakers

- **Noa Flaherty** - CTO & Co-founder ([LinkedIn](https://www.linkedin.com/in/noaflaherty/))
- **Prithvi Narasimhan** - Co-Founder and CTO ([LinkedIn](https://www.linkedin.com/in/prithvin/))

## Recap

Millions of patients leave the emergency room every day feeling overwhelmed. They have follow-up instructions, but navigating the complex healthcare system alone is a massive challenge. This gap in care can lead to missed appointments, worsening conditions, and costly readmissions.

This is the problem RelyHealth is solving. By empowering care navigators with AI, they ensure every patient gets the proactive support they deserve.

We recently sat down with Prithvi Narasimhan, CTO &amp; Co-Founder of RelyHealth, and our own CTO &amp; Co-Founder, Noel Flaherty, to discuss RelyHealth's playbook for building AI that is fast, safe, and secure. This recap covers their key learnings and the best practices you can apply to your own AI projects, especially in highly regulated industries.

“Over the past five years, we have supported over 50 emergency room departments across the country, and we’ve learned that there will never be enough human capacity... to cover everyone. And that’s really where AI can step in, not to replace humans, but to augment them.” - Prithvi Narasimhan, CTO &amp; Co-Founder at RelyHealth

RelyHealth set out to build AI-driven outreach agents that could call, engage, and triage patients at scale, escalating to a human navigator only when necessary. But building this for healthcare comes with a unique set of high-stakes challenges:

Reliability is paramount: The system cannot make mistakes. A hallucination or a missed escalation could have severe consequences for a patient. Auditing is mandatory: Every interaction must be documented accurately for doctors and health systems to review. Speed is critical: AI voice agents need to respond with low latency to feel natural, and development cycles must be fast to adapt to client needs.

## Key takeaways from the webinar

Here are the top insights from our conversation with RelyHealth:

AI augments human experts, it doesn't replace them. The goal is to give healthcare professionals "superpowers" to handle repetitive tasks, freeing them up for high-touch, complex patient needs. AI can deliver measurable efficiency gains. By automating initial outreach, RelyHealth's navigators are 10-15x more effective , allowing them to serve all patients, not just the most critical 10%. Accuracy is non-negotiable in regulated industries. Unlike an AI sales agent that can afford a minor error, healthcare AI must be precise. The cost of being wrong is simply too high. Structured data is the foundation of action. Converting unstructured conversations into clean, structured JSON is essential for auditing, follow-up tasks, and integration with Electronic Health Records (EHR). Observability is key to trust and speed. To build, debug, and maintain these complex systems, you need tools to trace every step of an AI workflow, identify failures, and resolve them in minutes, not days.

## Best practices for building high-stakes AI

Prithvi shared several key learnings from RelyHealth's journey. These practices are crucial for anyone building AI where the margin for error is zero.

### Increase care navigator efficiency by 10-15x

The most significant impact of RelyHealth's AI is the massive efficiency boost for their care navigators. Their AI phone system automatically calls patients with custom scripts, handles routine check-ins, and gathers necessary information. This means a single navigator can oversee the care of a much larger patient population.

“By using AI, we've seen that our navigators are 10 to 15x more effective than the rest of the market. They can speak to 10 to 15x more patients and reliably navigate them, just given that AI augments so much of the work they would otherwise be doing.” - Prithvi Narasimhan

This isn't just about making more calls; it's about enabling navigators to focus on what they do best: providing empathetic, human-centered care to patients who need it most.

### Ensure 100% reliability for critical escalations

In healthcare, you cannot afford false negatives. If a patient expresses a critical need or a concerning symptom, the system must recognize it and escalate to a human immediately, every single time.

“If a patient's, God forbid, suicidal, we need an escalation immediately. We can't wait for a tool call to potentially work the first time and not work the second time... We don't have that luxury.” - Prithvi Narasimhan

This requires rigorous testing, continuous evaluation, and guardrails to ensure the AI behaves predictably and safely. RelyHealth achieves this by building robust evaluation suites to test hundreds of edge cases before any workflow goes live.

### Generate auditable, structured JSON summaries

After an AI agent interacts with a patient, what happens next? The conversation needs to be translated into a clear, actionable record. A doctor needs to know what follow-up steps were taken, and a care coordinator needs a task list.

RelyHealth's system is designed to "generate incredibly accurate, structured JSON summaries to capture exactly what happened." This structured data can be seamlessly integrated into other systems, creating a reliable audit trail and ensuring that follow-up actions are never missed.

### Reduce debugging time from days to under 10 minutes

When a system is live in a production healthcare environment, you can't afford lengthy downtime. If an issue arises, it needs to be fixed immediately. Before implementing a dedicated AI development platform, debugging was a slow, manual process for RelyHealth.

As noted in a recent case study , their team can now resolve production issues with incredible speed. Natoli, a content engineer at RelyHealth, shared, “When one of our apps faces an issue in production, a doctor would contact us, and we’d resolve it in under 10 minutes. Vellum’s tracing views made it easy to identify exactly where the problem is.”

## How Vellum helps RelyHealth build faster and safer

To meet these demanding requirements, RelyHealth needed a core infrastructure partner. They chose Vellum to accelerate development, ensure reliability, and maintain full visibility into their AI systems. Prithvi explained they use Vellum in three primary ways: observability, traceability, and evaluations.

Here’s how Vellum’s platform empowers their team:

Rapid, No-Code Development: With Vellum's visual Workflow Builder, RelyHealth's content engineers can design, test, and deploy complex AI workflows without extensive coding. This has dramatically reduced their development cycle. “What once took a dozen engineers up to eight months can now be built in 24 hours by a single engineer using Vellum,” Prithvi stated. Automated Evaluations: To guarantee the reliability Prithvi emphasized, the team uses Vellum's Evaluation Suite. They can automatically test workflows against hundreds of scenarios at once, catching issues early and ensuring the AI performs correctly before it ever interacts with a patient. Instant Debugging: Vellum’s observability and tracing tools provide a complete record of every AI execution. When an error occurs, the team can instantly pinpoint the exact point of failure, replay the scenario, and deploy a fix in minutes.

For RelyHealth, AI isn't just about technology; it's about transforming patient care. By combining human expertise with AI workflows built on a reliable platform, they ensure no patient is left behind.

If your team is looking to build and deploy reliable, enterprise-grade AI applications with confidence, schedule a demo with Vellum to learn more.

‍
