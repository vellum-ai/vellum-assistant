---
title: "MCP UI & The Future of Agentic Commerce"
slug: "mcp-ui-and-the-future-of-agentic-commerce"
excerpt: "Learn about MCP UI and how it enables AI agents with the missing UI layer for the future of agentic commerce. "
metaDescription: "Learn about MCP UI and how it enables AI agents with the missing UI layer for the future of agentic commerce. "
metaTitle: "MCP UI & The Future of Agentic Commerce"
publishedAt: "2025-09-16T00:00:00.000Z"
readTime: "12 min"
isFeatured: false
expertVerified: false
guestPost: false
isGeo: false
authors: ["Nicolas Zeeb"]
reviewedBy: "David Vargas"
category: "All"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/9c836bacbb581b0bb016cb17dff8e1aa085f39e9-1192x629.jpg"
---

AI has had a substantial impact on the way we interact with the internet, and soon, your agent won’t just use the internet, it will become your browser.

People using search, clicking links, getting to page 2 of search results are all trending down, with Ahrefs recently finding that over the past year, their site’s average “search traffic has dropped by about 21%, while its AI traffic has grown roughly 10 times” [1] .

While the reality of this rise in AI traffic only makes up &lt;1% of their total traffic, AI bots interacting with the internet is steadily growing. So much so that the internet has taken notice and is preparing for the agentic internet to come.

Early validation of this comes from the growing use of robots.txt files. Introduced around 30 years ago by Martijn Koster , it acts as an instruction guide for AI site visitors to navigate and access pages on your site [2] .

So, as AI search and agentic capabilities enable us to put more trust in AI to do our internet bidding, use cases will continue to expand; in this article’s case we’ll cover the jump from searching to shopping enabled by recent developments in agentic technology: MCP UI.

## MCP recap

Before diving into MCP UI, it’s worth quickly recapping what MCP is. Model context protocol standardizes how AI agents connect to APIs, databases, and apps, by housing connections to these tools in a MCP server. This protocol enables a consistent way for agents to request and use services without custom integrations.

One MCP server can be connected to many different agents, with all of them able to access the same standard tool set for different purposes.

MCP has surged in popularity this year, even Paypal got in on the MCP action and agentic commerce potential by releasing “MCP-powered agentic APIs” that give AI agents direct access to PayPal core services [3] .

> Learn more about the hype vs the reality of MCP for AI agents here .

# What is MCP UI?

MCP UI is an extension of MCP that enables agents to embed interactive UI components in chat. It is currently an open source project pioneered by Ido Salomon in collaboration with Liad Yosef .

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/f8738f6fe351012fe844a1249d9752ab713b235f-2360x1142.png)

Instead of 100 messy integrations, MCP gives agents one native protocol to access thousands of tools. In the same way, MCP UI enables agents to construct and return hundreds of UI components directly in the browser or chatbots.

MCP UI houses the UI components from the host website in a standardized way allowing agents to see what components are available and context needed to render them directly in the chat.

Here’s a high-level flow for an agent interacting with MCP UI components:

Discovery: The client (e.g. ChatGPT) asks an MCP server what UI components are available. Response: The MCP server returns a JSON payload describing UI elements (buttons, forms, tables, etc.) plus metadata. Rendering: The client (ChatGPT) renders those components in-chat, giving the user a familiar interface without leaving the conversation. Interaction: Every user action (e.g., clicking “checkout”) is treated as a tool call back to the provider via MCP.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/c4ecd73c196a3fce984e3a01f11f2c2fc8b8f73b-1264x1260.png)

## What type of UI components can I build with MCP UI?

MCP UI isn’t limited to one way of surfacing interfaces. It gives developers flexibility in how they deliver components, depending on the complexity of the experience and how much control they want the host to have. The protocol currently supports three resource types:

Inline HTML – Simple UI elements (buttons, forms, tables, visual widgets) can be sent directly as HTML, CSS, and JavaScript. This is lightweight and perfect for quick, interactive elements embedded right in the chat. External URLs – Full web applications or existing pages can be displayed inside sandboxed iframes. This lets brands reuse what they already have while keeping the environment isolated and secure. Remote DOM – A more advanced option where the UI and events are described via JavaScript, and the host application renders them with its own native components. This ensures the interface looks and feels consistent with the AI assistant while still honoring vendor logic.

Taken together, these options mean developers can build everything from simple input forms to rich, end-to-end shopping flows — all delivered directly into an AI conversation.

## MCP UI as the enabler of agentic commerce

With Mastercard recently announcing a partnership with Microsoft to pioneer Agent Pay , the reality of furthering agentic commerce infrastructure with MCP UI is gaining traction quickly.

Mastercard is bullish on agentic commerce as “a new form of online and mobile shopping, in which an AI agent ‘closes the loop’ or completes tasks for a user…with limited or no manual inputs needed from that user” [4] .

This means online shopping will one day exit the browser and be fully functional within your favorite AI assistant’s interface. Discovery, comparing, and browsing all AI assisted to dramatically expedite buyer journeys and time to purchase.

In an interview with Goose Ido Salomon of Monday.com put it bluntly: *“*text isn’t really the way to go forward when talking about the agentic future” [5] . Visual, interactive UIs tailored to how humans think are the logical step forward in integrating AI further into our daily lives. MCP UI offers that bridge.

Shopify, another monolith in the eCommerce space, has echoed this push, noting that text-only agents fall short for commerce because buyers expect visual context in areas like product selectors to checkout flows [6] . With MCP UI, agents can surface interactive components through secure iframes or remote DOM, while intent-based messaging (view_details, checkout, notify) keeps state transitions smooth. Shopify has even open-sourced a reference implementation , showing how storefronts can be rendered end-to-end inside AI assistants.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/1bb80daa61d2dda80ed0ac572a920380827d2bff-1566x1014.png)

While the vision for agentic commerce through MCP UI is bold, the benefits for the current state of eCommerce are clear.

## Benefits of MCP UI for eCommerce

MCP UI is all about giving consumers a rich visual experience that traditional websites do, combined with the flexibility of AI agent functionality.

Imagine preparing for the NYC marathon, and ChatGPT is your agentic coach. If you asked it to help you find running shoes because your current ones hurt your feet, it has good context on the right shoe to help your performance. The only downside is that all it can give you is blocks of text with links to the products as it’s recommendation.

Now with MCP UI, the agent can surface the web merchant’s UI elements like images, size options, etc. in an iframe directly in chat, making it seamless to make an informed purchase.

For you, this eliminates all the time it would’ve taken to visit every link with the block text you would’ve had pre-MCP UI.

For developers and merchants developing this experience, it means less overhead and more reach. Instead of maintaining dozens of custom integrations or rebuilding UIs for each platform, devs can just build once and ship. Merchants can access deeper brand resonance and impression by allowing agents to surface UI elements with personalization for each user.

The enriched visual experience of MCP UI unlocks a new class of interactive experiences inside AI interfaces including:

Seamless scheduling: book appointments directly in chat without jumping to external calendars. Interactive product catalogs: browse and filter listings with images, descriptions, and pricing displayed in-chat. Embedded checkout flows: complete purchases securely inside the assistant, no redirects required. Dynamic seat selection: choose concert, flight, or movie seats through an interactive interface. Food ordering experiences: explore menus, customize orders, and pay without leaving the conversation. Rich data visualizations: surface dashboards, charts, or reports inline for faster decision-making.

### MCP UI benefits overview

Benefit What it means Seamless eCommerce experiences Booking appointments, browsing product catalogs, and checking out can all happen inside chat without redirecting to a website. Consistency and faster development Developers build UI components once and render them across any MCP-compatible AI interface which reduces duplication and maintenance. Better personalization Agents use unified user context to tailor interactions such as auto-filling forms, adjusting colors for accessibility, or translating content.

It’s good to note that all of these benefits have yet to be realized. MCP UI still needs to stand the test of time, but depending how builders approach standardization, all these benefits will come to fruition.

Big players in the eCommerce space have already taken notice and are beginning early stage adoption.

# The current state of MCP UI &amp; agentic commerce

Today, most MCP UI experimentation is happening inside controlled environments. Think prototypes running in ChatGPT or demos from companies exploring how to pass simple UI components like forms or buttons over MCP.

On the merchant side of things, control of the agent layer, and by extension the UI layer, is shaping up to be one of the biggest battles in commerce. To get a read on how things are shaping up Admetrics’ said “No one wants to be where the AI agents are shopping at – everyone wants to build AI agents that do the shopping” [7] .

This stems from Google’s launch of Shopping Genie , their AI shopping agent. In response, Shopify has updated its robots.txt to block unauthorized AI agents, while Amazon outright restricted Google’s shopping assistant from operating in its ecosystem.

For years, Amazon and Shopify have invested heavily in brand identity, finely tuned conversion funnels, and the collection of first-party data. Independent AI shopping agents threaten to bypass all of that, which explains why both companies are drawing hard lines against external agents and pushing to own the agent layer themselves.

This push-and-pull highlights the tension at the heart of agentic commerce: platforms want control, brands want access, and users want convenience. MCP UI sits directly in that crossfire because it dictates how those interfaces get passed through to agents.

So, while MCP UI is past the “cool demo” phase, it’s still far from a stable standard. It’s caught between technical feasibility and business politics, which makes the challenges ahead even more important to unpack.

## Challenges and risks to MCP UI adoption

At it's core, MCP isn’t perfect. As one the co-founder and CEO of Golf Wojciech Błaszak posted on LinkedIn, “MCP security just became everyone’s problem” as he told the story of user having their emails compromised from a malicious calendar invite that ChatGPT accessed using MCP [8] .

The worst part was that it had nothing to do with the invite itself. The attack worked by hiding a prompt injection in the calendar event, which the agent then treated as trusted data, ultimately exfiltrating private emails.

This illustrates the larger issue: MCP opens powerful connections, but without proper isolation, those same connections can be weaponized. Layer MCP UI on top, where entire interactive components are passed into chat, the potential attack surface grows even larger.

This is one of the many hurdles for MCP UI must overcome before agentic commerce can be brought from theory into reality:

Security: Passing Delivering UI components over MCP introduces new attack surfaces. Secure iframes are a practical default today, but the tradeoff between strong isolation and rich customization is still unresolved. User trust &amp; control: If agents can initiate purchases and handle sensitive data, users need clear permission flows, visibility into actions taken, and simple ways to revoke access or roll back changes. Platform policy &amp; control: Hosts and vendors may limit which agents or UI capabilities are allowed, creating fragmentation. Shared specs and capability negotiation will be needed to keep experiences consistent. Adoption: For MCP UI to work at scale, vendors must agree on specifications and invest in building compatible components.

The path to agentic commerce depends on how we tackle these gaps, which brings us to what the future needs to look like.

## The Future of MCP UI and Agentic Commerce

Looking ahead, MCP UI could evolve alongside generative UI to form the next stage in how we interact with the internet as a whole. A world, here agents not only deliver branded components, but also create new layouts and flows tailored to the user in real time.

That personalization could drive higher conversions than any traditional web experience. Imagine a shopping assistant that knows your style, budget, and accessibility needs, and automatically presents a checkout flow optimized just for you.

But the road to that future will be shaped as much by business dynamics as by technology. Will brands and platforms embrace openness, or will they wall off agent access? Will users trust agents enough to hand over control of purchases and personal data?

One thing seems clear: if agentic commerce is going to become mainstream, we’ll need MCP UI — or something like it — to make it usable, trustworthy, and scalable.

## Citations

[1] Ahrefs. (2025). AI Traffic Has Increased 9.7x in the Past Year .

[2] Tech Policy Press. (2025). Robots.txt Is Having a Moment: Here's Why We Should Care .

[3] PayPal. (2025). The Future of Commerce: PayPal’s Agentic AI .

[4] Mastercard. (2025). What is agentic commerce? Your guide to AI-assisted retail .

[5] Goose. (2025). &nbsp; MCP-UI: The Future of Agentic Interfaces .

[6] Shopify. (2025). MCP UI: Breaking the text wall with interactive components .

[7] Admetrics. (2025). The AI Shopping Platform Wars: How Shopify and Amazon Over the Future of E-Commerce .

[8] Błaszak, W. (2025). LinkedIn Post .

‍
