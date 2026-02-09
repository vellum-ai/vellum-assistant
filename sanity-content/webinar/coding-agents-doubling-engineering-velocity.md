---
title: "How we increased our PR count by 70% in 6 months with coding agents"
slug: "coding-agents-doubling-engineering-velocity"
shortDescription: "How we doubled our engineering team's PR output by building a system of foreground, background, and code review agents to 2x engineering velocity. You'll see the actual system we built including the exact tooling and workflows we built to maximize coding agent effectiveness, including our approach to parallelizing work and maintaining code quality at scale."
dateFrom: "2025-12-09T22:00:00.000Z"
videoRecording: "https://www.youtube.com/embed/cCREcpFpAj0?si=FX3ZziJZbouCheuf"
coverImage: "https://cdn.sanity.io/images/ghjnhoi4/production/34fff479d6125497dd2d0ff70626d3a6fa64eb7a-1478x780.png"
---

## Speakers

- **Eashan Sinha** - Engineer ([LinkedIn](https://www.linkedin.com/in/eashansinha/))
- **Noa Flaherty** - CTO & Co-founder ([LinkedIn](https://www.linkedin.com/in/noaflaherty/))

## Recap

In May 2024, our team of 15 engineers at Vellum shipped 946 PRs. By October, we built a system leveraging coding agents to merge over 1,900 PRs.

Rather than adding more engineering headcount, we invested time into implementing coding agents into every engineering workflow. This resulted in 37% of our PRs now being initiated by background agents, helping our engineers ship faster than ever without sacrificing code quality.

This webinar with special guest Eashan from Cognition, we discuss our learnings about making coding agents actually work at scale.

# Key Takeaways from the Session

Background agents drove 37% of PRs - Vellum merged over 1,900 PRs in October 2025 (up from 946 in May), with background agents like Devin handling more than a third of all pull requests Code review agents catch bugs humans miss - Codex and similar tools consistently identify issues in files outside the diff, including logic bugs that passed review by multiple senior engineers One-line commands are essential - Consolidating lint, test, and setup processes into single make commands dramatically improves agent success rates and reduces iteration time Preview environments enable async QA - Automated PR-specific staging environments let teams verify changes without local setup or blocking agent workflows Parallelization beats serial flow - The biggest productivity gain comes from running multiple agent sessions simultaneously rather than working on tasks one at a time in deep focus blocks Upfront tooling investment pays off - Building custom scripts, environment configs, and repo interfaces for agents improves both agent performance and human developer experience

# Best Practices

Set up a dedicated agent machine properly - Create a root .envrc file with necessary credentials, add all relevant repos with one-line setup/test/lint commands, and maintain snapshots of your agent's environment configuration Build repo interface standards - Consolidate complex multi-step processes (linting across microservices, database migrations, service startup) into single make commands that both agents and humans can use consistently Implement automated code review first - Start with code review agents like Codex before fully committing to background agents - they provide immediate value, catch real bugs, and let you merge faster with post-push human reviews for context sharing Use playbooks for processes, knowledge for context - Store step-by-step instructions (like PR description formatting) in playbooks that agents explicitly invoke, while using knowledge files for general preferences and codebase information Integrate agents into existing workflows - Connect coding agents directly to Linear, Slack, and other tools your team already uses so bugs and feature requests can be triaged to agents without context switching
