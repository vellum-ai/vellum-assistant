---
title: "Temperature"
slug: "temperature"
metaDescription: "Learn how to use the most important LLM parameter for building AI systems: LLM temperature! "
supportedBy: ["OpenAI", "Anthropic", "Google"]
cover: "https://cdn.sanity.io/images/ghjnhoi4/production/cc887716df4de299dafcc08f68ff9ed08a6f12ef-1090x750.heif"
---

# What is LLM Temperature?

The temperature parameter controls the randomness of the generated text. Adjusting the temperature changes how the model selects the next word in a sequence, influencing the creativity and predictability of the output. Low temperatures render outputs that are predictable and repetitive. Conversely, high temperatures encourage LLMs to produce more random, creative responses.

Temperature is one of the most important controls for developers. Some AI-powered applications need predictable outputs; others needs varying, chaotic results to deliver on a creativity-oriented product. Using temperature, developers can fine-tune LLMs to produce the ideal results.

Temperature is a widely-supported and popular feature to tweak outputs. It is distinct from other controls like Top P and Top K . Those controls filter which tokens should be considered based on their raw likelihoods. Temperature instead determines how an LLM will leverage those likelihoods.

# How does Temperature work?

### What are tokens?

LLMs work in piecemeal fashion, iteratively generating tokens. Tokens are the smallest unit of LLMs. They either represent short words (e.g. the ) or parts of words (e.g. bal and loon comprises balloon ). For every subsequent token, the possible options are assigned likelihoods.

### How does temperature relate to tokens?

Before generating each token, an LLM will consider different options. These options have weighted likelihoods. For example, imagine an output: I went to the zoo and saw .

For the next token, an LLM might consider likely options like lions (0.2) , hipp (0.13) (starting token for hippo), and croc (0.11) (crocodile). It’ll also consider less likely options like meer (0.004) (meerkat), &nbsp; mice (0.003) , and squid (0.003) .

Temperature regulates how an LLM weights these likelihoods. A moderate or default temperature will treat them at face value. A low temperature will optimize for higher likelihoods—increasing the net probability of lion or hipp . A high temperature will do the opposite, boosting the odds of meer and mice .

This control happens through a process called SoftMax , which helps the model decide which word is the best fit based on probability.

# How does the SoftMax function work?

When the model is deciding what words (or tokens) to pick next, it looks at raw scores called ** logits. **The SoftMax function function then converts this set of raw scores ( logits ) into probabilities. It basically takes a vector of numbers and converts them into a probability distribution, where the sum of all probabilities is equal to 1.

This allows the model to make decisions based on the relative likelihood of different token options.

Let’s look at an example:

Imagine an LLM is trying to predict the next word in a sentence. The model might assign the following logits to three possible words:

The SoftMax function converts these into probabilities:

The model is most likely to choose “cat” because it has the highest probability.

So with the temperature parameter this translates to:

Low temperature : Makes the SoftMax distribution sharper, favoring the highest probability words more strongly (less randomness).

High temperature : Flattens the distribution, making less likely words more probable (more randomness).

# How do you set Temperature?

It is fairly easy to set temperature on modern LLM APIs.

### OpenAI

You can set temperature on OpenAI’s Chat Completions API with the optional temperature parameter. temperature ranges from 0.0 to 2.0 , and defaults to 1.0 .

### Anthropic

You can set temperature on Anthropic’s Messages API with the optional temperature parameter. temperature ranges from 0.0 to 1.0 , and defaults to 1.0 . Notably, Anthropic doesn’t allow temperature to pass 1.0 .

### Gemini

You can set temperature on Gemini’s API with the optional temperature parameter. temperature ranges from 0.0 to 2.0 , and defaults to 1.0 .

# Does a temperature of 0 result in non-determinism?

A common case of confusion is if a temperature of 0 generates non-deterministic replies. In theory, yes. In practice, no.

As noted by this OpenAI Forum Thread , achieving non-determinism is impossible. A temperature of 0 makes the model always pick the most likely token, which is deterministic in principle, though in practice tiny implementation details (like hardware concurrency) can introduce very small variations.

However, LLMs are not run in a vacuum; race conditions of multi-threaded code impacts the established likelihoods of tokens. Consequently, while temperature reduces randomness to a minimum, it doesn’t eliminate them.

However, the randomness is minimized to the extent that developers can expect near non-determinism. For most queries that specify the structure of the expected output, this reduction in randomness is sufficient.

# What are the three major temperature settings?

There are three primary types of temperature settings.

### Low Temperature (less than 1.0 )

On most LLMs, a low temperature is a temperature below 1.0 . This will result in more robotic text with significantly less variance. This is ideal for applications that prioritize predictability.

### Medium Temperature ( 1.0 )

A temperature of 1.0 serves as a benchmark of average randomness and creativity. This is the default setting on most LLMs, and many applications will consequently use a temperature of 1.0 .

### High Temperature (more than 1.0 )

A temperature above 1.0 increases the “creativity” of a model by adding more randomness to the outputs. There are always significantly more low likelihood tokens than high likelihood tokens; therefore, by tippin

# How to experiment with Temperature?

Experimenting with temperature is relatively straightforward. First, understand the default temperature (typically a temperature of 1.0 ). Then, determine if you want to introduce more consistency or chaos.

If you chose a temperature close to 0.0 , you’ll get very predictable responses. Conversely, if you choose a temperature closer to 2.0 , you’ll see the LLM ramble like Shakespeare.

An extremely high temperature is rarely useful in production, unless the product is trying to deliver on esoteric responses. However, slightly higher temperatures than 1.0 can lead to more elevated or complex thinking, which is sometimes necessary. Conversely, for applications that need consistent responses for the same prompts, a temperature at or close to 0.0 is entirely appropriate.

# When to use Temperature?

Temperature is one of the most common tweaked settings when programmatically interfacing with an LLM.

There are some scenarios where temperature is particularly helpful:

When generating tutorials or documentation, a low temperature is preferred to keep language and format consistent When generating creative writing or poetry, a high temperature is ideal to generate varying responses When customer chatbot applications, a moderate-to-high temperature is often preferred to give the conversation personality. Conversely, if customers want more robotic answers, a lower temperature is better.

# What are alternatives to Temperature?

There are some other settings that provide similar, but distinct features to temperature. These could serve as good alternatives in niche scenarios.

### What is Top P?

Top P, also known as nuclear sampling , filters the tokens that should be considered for each iteration. Top P defines the probabilistic sum that the chosen token’s likelihoods should add up to. Notably, Top P is not a percentage of tokens; a Top P of 10% defines the minimum quantity of tokens needed to sum to 10% of the net likelihoods.

Top P can be mixed with temperature, but that is typically not advisable. While temperature is typically used over Top P, Top P is useful when token options aren’t as long-tailed.

### What is Top K?

Top K is similar to Top P, but instead defines a quantity of the most probable tokens that should be considered. For example, a Top K of 3 would instruct the LLM to only consider the three most likely tokens. A Top K of 1 would force the LLM to only consider the most likely token.

A low Top K is similar to a low temperature. However, Top K is a more crude metric because it doesn’t account for the relative probabilities between the options. It’s also not as well-supported, notably missing from OpenAI’s API.

‍
