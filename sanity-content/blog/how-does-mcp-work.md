---
title: "How does MCP work "
slug: "how-does-mcp-work"
excerpt: "and how you can build one with Vellum"
metaDescription: "Everything you need to understand MCP and how to set up both the client and server to use it."
metaTitle: "How does MCP work "
publishedAt: "2025-04-22T00:00:00.000Z"
readTime: "8 min"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
authors: ["Anita Kirkovska", "David Vargas"]
category: "LLM basics"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/65eca72d57be1c26434be4e37c79f09f1b63d94d-1536x1024.png"
---

The best thing you can do to help improve LLM outputs is to integrate it with your knowledge sources. But doing that manually for each source (especially if you’re building an agent) could be very complex.

So, what if your workflows could talk to all your systems through a shared layer?

That’s what MCP is.

It’s a new protocol that standardizes the communication between LLM-powered apps and external data sources or tools. While it still has it’s quirks, it’s moving the field forward of what’s possible with LLMs.

The protocol looks promising, but you should definitely think twice if you want to put it in production today ( more on that here ).

Here’s what it is and how to start using it.

# The components of MCP

MCP uses a client-server setup, kind of like how your browser talks to a website.

There are usually three main parts (or roles) involved, and they send messages back and forth in a specific format called JSON-RPC 2.0 . These messages can travel through different channels like WebSockets (real-time connections), HTTP SSE (for updates), plain input/output, or UNIX sockets (used in some local setups).

In a typical MCP setup, there are three primary roles:

MCP Hosts: These are the primary LLM applications that initiate and manage connections. Examples include AI chat interfaces (like Claude Desktop), or an IDE. The Host manages the overall lifecycle and often enforces security policies.

MCP Clients: These reside within the Host application. Clients are responsible for establishing and maintaining the 1:1 connection with specific MCP Servers according to the protocol specification.

MCP Servers: These are lightweight applications designed to expose specific capabilities like access to a data source (like a file system, database, or API) or a tool (like a code execution environment or a specific function). Servers listen for requests from Clients, perform the requested operation, and return results in the standardized MCP format.

# MCP Servers

The MCP Servers offer capabilities to the Clients through defined primitives: Resources, Tools and Prompts.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/166e4bf4990ed7b0b59793de96ae9e5e39dd57ee-1536x1024.png)

### Resources

Resources allows servers to expose contextual data or content to the LLM or the end-user. This could be in the form of files, database query results, API responses, or other relevant information that the LLM can use to generate more informed responses.

The resource below, the get_readme function allows the AI agent to retrieve the README file of a specified GitHub repository, providing context for further analysis.

Tools Tools enable servers to expose functions or actions that the LLM can request to be executed. This is crucial for building agentic systems where the AI can perform tasks like running code, sending messages, updating records, or interacting with external services.

Now from the example above, let’s add an analyze_issues function that defines a tool which enables the AI agent to fetch and analyze open issues in the specified repository.

‍

By integrating both resources and tools in the same MCP server, your AI agent can first gather necessary context (e.g., repository README) and then perform actions (e.g., issue analysis) based on that context.

### Prompts

Prompts offer pre-defined prompt templates or workflows to the user via the Host application. This helps guide users and structure interactions with the server's capabilities.

Now let’s add a review_code function that will define a structured prompt that guides the AI agent to perform a code review on a given code snippet.

Final output

You can clearly see how this MCP setup enables LLMs to integrate resources, tools and prompts and integrate with external systems almost on auto-pilot.

Combining these three components we get an implementation that looks something like this:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/1cc04ec2ecd8ef7e875809e9fae4e34fd9df8677-1536x1024.png)

### Roots

Roots : These a re specific starting points, like folders or URLs, that a client application tells the server to focus on. This helps the server know where to look for relevant information.

Example Scenario:

An Integrated Development Environment (IDE) acting as an MCP Client can specify the current project directory as a root. This informs the Server to operate only within this directory, accessing relevant files for tasks like code analysis or documentation generation.

Implementation Steps:

1/ Declare Roots Capability:

During initialization, the Client declares support for roots:

2/ Provide Roots List:

The Client sends a roots/list response containing the designated roots:

3/ Handle Roots Changes: ‍

If the roots change (e.g., the user opens a different project), the Client sends a roots/list_changed notification to inform the Server.

### Sampling

Sampling enables the Server to request the Client to perform tasks using its integrated LLM, such as summarizing data or generating code. This allows the Server to utilize the Client's LLM capabilities without direct access.

Example Scenario:

A Server handling GitHub repositories might request the Client to generate a summary of recent commits. The Client uses its LLM to process the request and returns the summary to the Server.

Implementation Steps:

1/ Declare Sampling Capability:

During initialization, the Client declares support for sampling:

2/ Handle Sampling Requests:

When the Server sends a sampling/createMessage request, the Client processes it using its LLM:

3/ Return the LLM's Response:

After processing, the Client returns the generated message to the Server:

You can clearly see that we can utilize the power of LLMs with both the server and the client, but in different ways:

A server processes a user's request using its LLM to determine the necessary tools or data. It then requests the client to perform specific LLM tasks via Sampling, such as generating summaries or interpreting results. The client processes these tasks and returns the outcomes, which the server uses to complete the workflow.

# Function Calling vs MCP

Now, many people were confused as to how function calling differs from MCP. And while these concepts might sound similar, there is a big difference about them.

Function calling is a static model feature that turns user input into parameters for a function. It does not call any functions, it just generates the parameters for it.

MCP however, standardizes how those function calls are executed, managing tool discovery, invocation, and response handling in a consistent and scalable manner.

Function calling is about WHAT and WHEN to use a tool.

MCP is about HOW tools are served and discovered in a standardized way.

Check the table below for a better comparison:

Function Calling vs MCP Feature Function Calling Model Context Protocol (MCP) Setup Requires manual setup for each function Uses a standard protocol to access tools dynamically Flexibility Limited – AI can only use what’s been predefined High – AI can discover and use new tools on the fly Structure Rigid – functions have fixed inputs/outputs Flexible – supports varied input/output structures Adaptability Low – changes need manual updates High – adapts to new tasks without reprogramming Use Case Fit Best for repeatable, well-defined tasks Best for evolving or multi-tool workflows Scalability Harder to scale – setup grows with number of functions Easier to scale – tools follow the same protocol Learning Curve Easier to grasp initially Requires understanding of the protocol framework Examples Classic API-based tool use Composio’s MCP for AI tool orchestration

# Why is MCP useful

MCP enables developers to build more powerful AI applications that go beyond what we deemed possible using previous approaches.

The first foray has been into making our IDE’s and code assistants (e.g. Cursor) smarter. They can use MCP servers to access local file systems, understand project structures, interact with Git, run linters, or execute code.

Other areas where we see increasing application of MCPs is with:

Chatbots : Think Claude Desktop using MCP to allow users to grant access to local files, for example Notion. Enterprise integration: Companies are thinking of integrating their LLMs with their internal databases (e.g. Postgres) or business apps like Slack. Although we don’t recommended you to do that at this point. Agents (of course): Everyone is trying to build multi-step agents that can perform a multitude of actions using external data/tools. However, this is still very hard to manage in production. An example for this is an MCP server that reviews GitHub Pull Requests that fetches code, uses the LLM (via sampling) for analysis, and posts comments back to GitHub.

# MCP Demo

Here’s a quick video of how Vargas, our founding engineer built an MCP that enables him to chat with his GitHub repo.

Link to the implementation: mcp-demo

# FAQ

### What’s the difference between exposing my API to an LLM vs building an MCP server?

Exposing your API to an LLM usually means writing glue code or plugins for each use case. Building an MCP server lets you define your capabilities in a standard format, so any MCP-compatible LLM can use them out of the box. It's like plugging into a shared language instead of translating everything manually.

### When should I use a Resource vs a Tool?

When deciding between implementing a Resource or a Tool for an LLM interaction, consider both the nature of what you're providing and who is responsible for selecting or acting upon the information. Use a Resource when you're exposing specific data or context that the LLM should be aware of and can reference directly. A helpful analogy is to think of Resources as "UI Affordances" for the end-user; they are most suitable when the user explicitly provides, attaches, or selects the specific item the LLM should utilize, such as choosing a particular file for analysis or pointing to a specific document. In essence, the user performs the initial filtering by selecting the precise data source.

Conversely, use a Tool when you're offering an action that the LLM can initiate or perform. Tools are appropriate when the system or the LLM itself needs to execute a task, which might involve searching across, processing, or interacting with multiple potential underlying resources behind the scenes to find an answer or complete a request, like searching a knowledge base, sending a message, or triggering a workflow. In this case, the LLM/system, guided by the tool's purpose, is responsible for filtering or searching through potential information sources to fulfill the user's broader request, rather than the user pre-selecting a single, specific item.

### If I want to expose access to my database, is that a Tool or a Resource?

It depends.

If you're sharing data from your database for the LLM to read or reason about, that’s a Resource . If you’re allowing the LLM to write, update, or trigger something in the database, that’s a Tool .

### How do I build authentication and scoping for MCP Servers?

It's important to understand that MCP (as of April 2025) currently lacks a standardized, built-in mechanism for authentication and authorization , which is a recognized limitation and potential downside. Because the protocol itself doesn't handle credential management or propagation between the client and server, securing your MCP server endpoint is entirely your responsibility .

This often leads to practical patterns where authentication credentials, like API keys or tokens, need to be managed and passed directly within the requests or configurations used by the client calling the MCP server.

While MCP doesn't enforce a specific method, it expects your server implementation to perform its own checks. Common approaches include:

Validating API keys passed in request headers or payloads. Verifying OAuth tokens (obtained through a separate flow) presented by the client. Using session-based tokens or other custom authentication methods.

Similarly, scoping – defining what specific actions an authenticated identity is permitted to perform – must also be implemented entirely within your server's logic based on the validated credentials, just as you would when securing any traditional API endpoint. You control which keys or tokens grant access to which capabilities offered by your server.

### Should I build an MCP Server for my API?

You should strongly consider building an MCP Server for your API if you're encountering customer questions like:

"Can your product integrate with our company's existing LLMs or AI agents?" "Does your product offer an AI feature that can perform specific business logic?"

MCP provides a powerful and standardized answer to both scenarios. For the first question, it offers a common interface , allowing you to say "yes" to integration requests more easily, without needing to build custom connections for every different LLM or AI platform your customers might use.

For the second type of question, MCP enables you to respond effectively even if you haven't built that specific AI feature natively. You can state: "You can connect your preferred AI agent or LLM to our MCP server, and leverage our core API capabilities to build that exact functionality." This empowers customers to use their chosen AI tools to create sophisticated workflows on top of your product's foundation.

Furthermore, offering an MCP server can be strategically valuable, especially in enterprise sales cycles. It demonstrates that your platform is AI-ready and extensible. For buyers looking to ensure their tools incorporate AI, providing an MCP interface allows them to effectively "check the box," knowing they can integrate AI capabilities (even if powered by their own LLM) through your standardized server.

### Do my customers want to access my product through MCP?

Whether your customers want to access your product through MCP largely depends on who those customers are, especially given the current state of the MCP ecosystem (as of April 2025).

The primary audience for MCP access right now is likely to be technical users – developers, engineers, or technically adept teams who are actively building features integrating LLMs with external tools and data sources. For this group, MCP can be appealing as it offers a potentially standardized, developer-friendly way to pull in your product's data or trigger its functionality within their AI workflows, potentially simplifying integration compared to building custom API clients from scratch.

However, it's crucial to recognize the current practical limitations:

Technical Overhead: Interacting with MCP servers might involve setup or operational steps (like managing server instances or configurations) that are more suited to users with technical expertise. Authentication: The current lack of a fully standardized, built-in authentication mechanism means users often need technical knowledge to manage credentials (like API keys) effectively.

Therefore, while the potential for MCP is broad, its practical appeal right now is strongest among users comfortable with these technical requirements. Non-technical users are less likely to directly demand MCP access until the platform matures further in usability and standardized security features.
