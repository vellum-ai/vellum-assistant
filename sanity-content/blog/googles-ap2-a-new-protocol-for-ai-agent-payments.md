---
title: "Google's AP2: A new protocol for AI agent payments"
slug: "googles-ap2-a-new-protocol-for-ai-agent-payments"
excerpt: "How verifiable mandates are creating a secure foundation for AI-driven commerce."
metaDescription: "How verifiable mandates are creating a secure foundation for AI-driven commerce."
metaTitle: "Google's AP2: A new protocol for AI agent payments"
publishedAt: "2025-12-03T00:00:00.000Z"
readTime: "4 min"
isFeatured: true
expertVerified: true
guestPost: false
isGeo: false
authors: ["Anita Kirkovska"]
reviewedBy: "Nicolas Zeeb"
category: "Guides"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/04798c63b638eb73345c311350dd8df91f7f240d-1186x629.jpg"
---

AI agents are rapidly evolving. They're moving beyond simple conversations to become active participants in our digital lives, capable of understanding complex requests and performing multi-step tasks on our behalf. As Holt Skinner, a Developer Advocate for Google Cloud AI, puts it, this opens up "a new frontier for building agents that can browse, negotiate, and make transactions for users."

Imagine telling an AI, "Find me the best deal on a pair of carbon-plated running shoes, men's size 11, for my marathon next month and buy them." The agent could research options, compare prices, and complete the purchase without you ever visiting a website. But this powerful new capability exposes a fundamental weakness in our current systems. Our entire global payments infrastructure was built for humans, not autonomous AI agents. So, today's payment systems assume a human is directly clicking buy.

When an autonomous agent initiates a payment, it raises critical questions that our current infrastructure can't answer:

Authorization: How can we prove a user gave an agent specific permission for a particular purchase? Authenticity: How can a merchant be sure an agent's request is accurate and not an AI hallucination? Accountability: If fraud occurs, who is responsible? The user, the merchant, the bank, or the AI model itself?

To address this challenge, Google, in collaboration with over 60 organizations like Mastercard, PayPal, and Adyen, has introduced the Agent Payments Protocol, or AP2. It's an open-source protocol designed to create a secure and trusted foundation for the future of AI-driven payments.

## What is the agent payments protocol (AP2)?

AP2 is an open, non-proprietary protocol that provides a common language for secure transactions between agents, users, and merchants. It's designed to be compatible with existing standards like Agent-to-Agent (A2A) and Model Context Protocol (MCP), allowing developers to build upon their existing work.

The protocol is built on five core principles:

Openness and Interoperability: As an open-source project, it fosters a competitive and innovative environment where anyone can contribute. User Control and Privacy: The user is always in control, and sensitive data is only shared with explicit permission. Verifiable Intent, Not Inferred Action: Transactions are anchored to deterministic, cryptographically signed proof of intent from all parties, directly addressing the risk of agent error or hallucination. Clear Transaction Accountability: The protocol creates a non-repudiable cryptographic audit trail for every transaction, providing clear evidence to resolve disputes. Global and Future-Proof: While the initial version supports card payments, the roadmap includes push payments like bank transfers and digital currencies to evolve with global payment trends.

## How it works: The power of verifiable mandates

The central innovation of AP2 is its use of Verifiable Credentials (VCs) , which act as tamper-proof, cryptographically signed digital contracts called "Mandates." These mandates serve as the verifiable proof of a user's instructions, creating a secure chain of evidence for every transaction.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/13e7a02e07fce7588b27ad53f263fb68377cce58-2296x1360.png)

AP2 addresses the two primary ways a user will shop with an agent:

### 1. Real-time purchases (human present)

This is for when you're actively engaged with the agent. Let's say you ask it to buy a specific pair of running shoes. Your approval of the final cart generates a Cart Mandate . This mandate is a cryptographically signed, unchangeable record of the exact items, price, and shipping information, ensuring what you see is what you pay for.

### 2. Delegated tasks (human not present)

This is for tasks you want the agent to perform later, like, "Buy tickets for this concert the moment they go on sale at midnight." In this case, you sign a detailed Intent Mandate upfront. This mandate specifies the rules of engagement—price limits, timing, and other conditions. It serves as verifiable, pre-authorized proof that allows the agent to automatically generate a Cart Mandate on your behalf once your precise conditions are met.

In both scenarios, a separate Payment Mandate is also created. This signals to the payment network and banks that an AI agent was involved, providing them with the necessary visibility to manage risk.

## A step-by-step example of an AP2 transaction

Let's walk through a simple, human-present purchase flow to see how these pieces fit together:

The Request: A user asks their shopping agent to buy a product. Building the Cart: The agent interacts with the merchant's system to build a cart with the correct item and price. Merchant's Guarantee: The merchant cryptographically signs the cart first. This is a guarantee that they will fulfill that exact order at that price. User Approval: The agent presents the merchant-signed cart to the user. When the user approves the purchase, their device cryptographically signs both the Cart Mandate for the merchant and the Payment Mandate for the network. Execution: The transaction is securely executed.

This process creates a "clear paper trail." The merchant has cryptographic proof of what the user approved, which is essential for assigning accountability and resolving any potential disputes.

## Beyond simple shopping with Cart Mandates

The true power of AP2 lies in its ability to enable entirely new commercial models by turning transactions into secure, auditable conversations. Imagine if you can enable the following experiences:

Subscription Flexibility : A customer sets an Intent Mandate: “Always keep me stocked with pet food for my dog, but swap in whatever brand is on sale, as long as the ingredients are grain-free and the bag size is at least 20 lbs.” The agent can auto-negotiate substitutions with different merchant agents, ensuring convenience while maximizing savings.

Event-Driven Commerce : A music fan tells their agent: “If Beyoncé announces any New York tour dates, grab me two tickets under $200 each, seated together.” The agent monitors official ticketing channels and executes a cryptographically signed purchase instantly once availability opens, eliminating the need for manual refreshes or risky secondary marketplaces.

Group Negotiations : A group of friends planning a ski trip can each set mandates for rental gear and lift passes. Their agents pool the requests and negotiate with the resort’s agent for a discounted group package, then finalize a single coordinated transaction that splits payments automatically.

Dynamic Insurance Bundling : A traveler books a car rental in Europe through their agent. The agent automatically queries insurance agents in real time to bundle short-term coverage for accidents, theft, and medical emergencies, presenting a clear bundled premium. The entire package is executed in one verified conversation before the trip begins.

Sustainability-Based Purchases : A consumer sets: “For all my grocery orders, prioritize local or carbon-neutral suppliers. I’m willing to pay up to 10% more.” The agent filters merchants and routes orders to sellers who meet sustainability standards, while merchants’ agents compete to fulfill those mandates transparently.

## The growing ecosystem: From protocols to platforms

A protocol is only as useful as its adoption. AP2 provides the foundational trust layer, but a thriving ecosystem of tools and services is needed to bring agentic commerce to life. This is already beginning to happen.

While AP2 solves the problem of secure authorization, other challenges remain, such as how to bill for complex, usage-based AI services. This has created an opportunity for new companies to build the next layer of infrastructure. For example, Y Combinator-backed startup Autumn is building what it calls "billing infrastructure for AI." They recognize that traditional payment platforms like Stripe are too low-level for the flexible pricing models AI companies need (e.g., usage-based billing, credits, and rollovers). Autumn provides a layer on top of Stripe to manage this complexity, demonstrating how the market is evolving to support the unique needs of an agent-driven economy.

## Conclusion: How to get involved

AP2 is a critical piece of infrastructure for a future where AI agents transact securely and reliably on our behalf. By establishing an open, verifiable, and accountable standard, it paves the way for a new era of AI-driven commerce.

The project is open-source and community-driven. If you want to learn more or contribute, you can find the complete technical specification, documentation, and reference implementations in the public AP2 GitHub repository . As the team says, building this future will require community feedback, expertise, and contributions.

## Extra resources

Beginner’s Guide to Building AI Agents → Best Enterprise AI Agent Builder Platforms → Best Low code AI Workflow Automation Tools → Guide: No Code AI Workflow Automation Tools → Best AI Workflow Platforms →

{{general-cta}}
