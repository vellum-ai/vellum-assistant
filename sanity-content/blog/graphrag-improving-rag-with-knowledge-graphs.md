---
title: "GraphRAG: Improving RAG with Knowledge Graphs"
slug: "graphrag-improving-rag-with-knowledge-graphs"
excerpt: "Learn how combining knowledge graphs with vector stores can make your AI applications more accurate and reliable."
metaDescription: "Learn how combining knowledge graphs with vector stores can make your AI applications more accurate and reliable."
metaTitle: "GraphRAG: Improving RAG with Knowledge Graphs"
publishedAt: "2024-08-02T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Compare GraphRAG with vector-only RAG today"
authors: ["Anita Kirkovska", "Vasilije Markovic"]
category: "Guides"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/d670f0890c8a69fefde8fa430a145eee2f29fab6-1107x762.png"
---

If you want to build anything worthwhile with LLMs, you can't just use them out of the box. They can "hallucinate" on unfamiliar topics and struggle with proprietary data on their own.

Yes, I know what you're thinking—RAG or fine-tuning can solve this. But both methods have their downsides—they often miss the real-world context and nuance that makes information feel complete and connected to what you already know. Plus, they usually leave you guessing about why you got that particular answer.

So what can we do to improve traditional RAG?

Enter GraphRAG — a new approach that uses knowledge graphs in addition to vector search to enhance answers at query time.

Microsoft, Lyft, and LinkedIn have published compelling research showing that GraphRAG consistently delivers more accurate answers across a broader range of questions compared to basic RAG.

This article is meant to demystify some of the questions around GraphRAG, and provide more information on the current architectures.

> We especially appreciate the input from the founders who are building the infrastructure for GraphRAG: Vasilije Markovic (Cognee.ai), Guy Korland (Falkordb), and Kirk Marple (GraphLit) — Thank you!

Now, let’s start at the beginning — &nbsp;at the representation layer.

‍

Representing Knowledge: Vectors vs Graphs

## Vector representations

To improve LLM output, many turn to vector databases to fetch context-rich data during queries. These databases use embedding techniques to represent data as vectors , placing similar words closer together in a vector space. This way, you can perform a vector search to retrieve relevant chunks of data for a user's query, providing more context for the LLM prompt.

This implementation has enabled many LLM use-cases — &nbsp;it works with unstructured data, it’s fast, scalable and cheap. And it truly feels like the perfect solution —until you need to do this at scale and understand how results are retrieved, their relationships and how they connect as a whole.

## Graph representations

Lately, there's been a lot of discussion about combining knowledge graphs with vector stores to improve accuracy and create RAG applications in a more declarative way.

Graph generation is easy with LLMs: you can define ontologies for your business processes and use LLMs to build the graph. Think of these ontologies as "train tracks" that guide the LLM’s responses, improving accuracy. Once the knowledge graph is in place, it’s much easier to maintain and update your RAG application. It can also provide a clearer picture of how different entities (nodes) are connected (edges), which offers a significant benefit over relying solely on vector stores.

This hybrid approach can power new use-cases as well.

For example, Graphlit’s product leans more on understanding entity-to-content relationships on top of just entity-to-entity connections as it might unlock more insights from the data:

> "Graphlit powers GraphRAG by focusing on entity-to-content relationships as well as entity-to-entity connections. Instead of merely mapping entities to each other, we aim to understand how entities relate to specific types of content and how this content interconnects." ‍ Kirk Marple , CEO and founder of Graphlit

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/aec4ca6383dab98d3274c88e3903934f10d0b554-1200x400.png)

Vectors and knowledge graphs are two different ways to represent information, but they complement each other well.

Because of this, there's a growing interest in combining them to enhance current RAG architectures.

‍

Introducing GraphRAG

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/99d230954a54b6ee103c7471b5a83823206bb2da-12720x5254.png)

Fundamentally, GraphRAG is a new retrieval approach that uses knowledge graphs in addition to vector search in a basic RAG architecture. Because of it’s structure, it can integrate and make sense of diverse knowledge, providing a broader and more holistic view of your data.

> "While Vector RAG focuses on narrow, context-specific retrieval, GraphRAG broadens the horizon, integrating diverse knowledge through graph structures. In essence, Vector RAG is AI myopia, limiting vision, whereas GraphRAG sees the bigger picture, enabling more holistic and insightful AI solutions." Guy Korland, Co-founder at Falkordb

Instead of just providing text chunks to the LLM, GraphRAG can supply structured entity information, including descriptions, properties, and relationships. We can see it becoming very useful if you want to connect different domains, or independent datasets. Imagine if you’re running an e-commerce business and you want to understand the relationships between your sales data, model user, timeline, purchases and activity + 3rd party data source or two — it’ll become easier with graphs in the mix.

The benefits of GraphRAG over vector-only RAG look very good too:

higher accuracy and more complete answers; easier development and maintenance of RAG applications; and better explainability, traceability, and access controls.

While this approach is still developing and further evaluations are needed, we’ve seen developers implementing GraphRAG in various ways already. Let’s look at some of these patterns.

‍

Emerging Patterns

If we want to use GraphRAG, we first need to understand how knowledge graphs can be used to organize the data (1) and how it can be integrated in your RAG stack (2).

## How can we use KG

Knowledge graphs can be used to build ontologies, categories, labels or user personas to enable better understanding of the “knowledge” in the data. Besides improving data representation for basic RAG implementations, there's growing interest in using them to create better cognitive scripts for agentic workflows.

> Combining knowledge graphs and vector stores is useful for connecting different domains or linking independent datasets. For example, you can take e-commerce data, user activity, and third-party sources to build relationships between them. This approach goes beyond simple search, providing recommendations that act like cognitive scripts offering personalized advice based on combined data. For instance, it might suggest, 'Hey Mike, you need to do X based on info from Y, Z, and B.' By integrating dynamic relationships and isolated environments, this method can power many agentic workflows Vasilije Markovic, CEO at Cognee.ai

## Where to integrate KG in your RAG stack

### 1. &nbsp;Query Augmentation

This is the most common approach that we’ve seen so far.

For a given query, extract key entities and relationships from a knowledge graph. Combine the extracted entities + query, and filter what you’ll search in the vector database — the semantic search will only return content which has observed these three entities. Then, use the vector results as context in the LLM call.

This strategy adds missing context to queries and corrects bad ones. It also allows for integrating a company’s specific definitions and views on certain terms.

🦾 Example, Customer Support: Linkedin used knowledge graphs to cut down their ticket resolution time from 40 hrs to 15 hrs with their GraphRAG implementation. They parsed customer support tickets into knowledge graphs and embedded each node. Their GraphRAG-based system then identifies relevant sub-graphs by traversing and searching for semantic similarities.

### 2. Answer Augmentation

This approach uses a knowledge graph to enhance the LLM's response with additional facts after the vector retrieval was performed. It retrieves relevant entities and properties from the knowledge graph, making it ideal for settings like healthcare and legal where detailed information is crucial.

Another examples from the latest Microsoft research involved analyzing a news article dataset from Russian and Ukrainian sources. For the query "What are the top 5 themes in the data?", they extracted entities like "Conflict and Military Activity, Political Entities, and Infrastructure Concerns", built a knowledge graph organizing data into semantic clusters, and augmented the prompt at query time.

🦾 Example: This is especially useful for including disclaimers or caveats in answers based on certain concepts mentioned or triggered. For instance, in a healthcare setting, if an LLM provides information about a medication, the knowledge graph can augment the response with important disclaimers about potential side effects or interactions with other drugs.

### 3. Answer Control

This approach employs knowledge graphs to verify the accuracy of an LLM's output. For example, a knowledge graph constructed from external data sources like Wikipedia can be useful. While Wikipedia itself isn't a definitive source for RAG systems, it can serve as commonsense knowledge to help guard against LLM hallucinations.

🦾 Example: If an LLM generates a historical fact, the knowledge graph can cross-reference this information with Wikipedia entries to ensure its accuracy, adding a layer of reliability to the responses.

Adding knowledge graphs in RAG can seem like a complex tax — but new solutions that are making this process easier are emerging.

‍

GraphRAG Providers

The available GraphRAG solutions handle key steps like ingestion, extraction, and enrichment. Check out the links below to explore them all.

Graphlit : Graphlit powers GraphRAG by focusing on entity-to-content relationships as well as entity-to-entity connections. Their platform supports data ingestion, extraction, and enrichment using knowledge graphs, vector databases, and data stores. It can ingest various data types (e.g., PDFs, MP3s, images) as JSON, then extract entities as a knowledge graph. All data is stored in a hybrid system, incorporating a vector database, cloud object storage and graph database. Additionally, it can enrich entities by integrating with external services like Crunchbase and Wikipedia. FalkorDB : FalkorDB is a knowledge graph database that offers full text search and vector similarity. It’s designed for high performance and scalability, using a low-latency, Redis-powered architecture to ensure fast response times even with growing data volumes. It also offers advanced query optimization techniques to efficiently execute complex queries involving both vector and graph data. Cognee : Cognee lets you create tasks and contextual pipelines of tasks that enable composable GraphRAG, where you have full control of all the elements of the pipeline from ingestion until graph creation. They also combine vectors and graphs to discover new types of relationships in the data and better way to represent data. Neo4j: Neo4j is a popular open-source graph database with vector search. It’s designed to efficiently store, manage, and query data represented as graphs. It excels in handling highly connected data, making it an ideal choice for building knowledge graphs . WhyHow : WhyHow.AI provides tools for building and managing knowledge graphs easily. WhyHow’s design encourages the creation of many small, specialized knowledge graphs which can be queried independently. It also provides guardrails like rule sets that allow you to better control the data being fed to your RAG pipelines.

‍

Still thinking if GraphRAG is worth it?

If you’re still thinking whether to explore GraphRAG, let’s leave you with these insights:

1). Higher quality responses. Validated by a recent benchmark , by Data.world that showed that GraphRAG, on average, improved accuracy of LLM responses by 3x across 43 business questions.

2) Cheaper and more scalable. In a recent paper , Microsoft discovered that GraphRAG required between 26% and 97% fewer tokens than alternative approaches

3) More useful answers. Linkedin used GraphRAG to cut down their ticket resolution time from 40 hrs to 15 hrs with their GraphRAG implementation.

4) Easier to debug AI apps. Neo4j reports that their users are able to build and debug their GenAI applications in better and unexpected ways. Graphs are going to be used even more in Agent workflows as well.

5) Explainable! GraphRag can make the reasoning logic inside of GenAI pipelines much clearer, and the inputs a lot more explainable.

6) Surfaces hidden connections. Finding new relationship in a large corpus is hard with vector stores alone, and GraphRAG can help there.

‍

Conclusion

The benefits of GraphRAG over vector-only RAG are clear: we can potentially build more reliable AI applications with higher accuracy that are easier to understand, debug, and maintain.

However, as with all AI development, it's crucial to evaluate how GraphRAG performs in specific use cases to fully understand its potential and limitations. We recommend trying this approach because it might improve the reliability of your AI applications and help you better understand how your AI interacts with your data.

If you decide to implement GraphRAG, we suggest exploring some of the available providers. If you need help pulling everything together, Vellum is here to help.

Vellum is a complete AI development platform that makes it easier to build, evaluate, and deploy AI applications with confidence. Book a call with one of our experts to see how Vellum can support your AI projects!

More resources:

Knowledge graphs for RAGs : A course by DeepLearning

‍

## Table of Contents

Vectors vs Graphs Introducing GraphRAG GraphRAG Patterns GraphRAG Providers Is GraphRAG worth it? Conclusion
