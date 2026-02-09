---
title: "Subliminal Learning in LLMs"
slug: "subliminal-learning-in-llms"
excerpt: "LLMs carry hidden traits in their data and we have no idea how."
metaDescription: "LLMs carry hidden traits in their data and we have no idea how."
publishedAt: "2025-07-27T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
authors: ["Anita Kirkovska"]
category: "Guides"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/eebd6ce03da5f2e6c33260e7c015ffe9aa5fdc16-1536x1024.png"
---

Many models today are trained on data from other models.

OpenAI and Anthropic use teacher models to generate synthetic data for training new ones. That’s how we got GPT-4o, Claude 3.7. That’s also a key part of what makes DeepSeek R1’s architecture so powerful.

It’s also how many companies fine-tune today: using stronger models to teach smaller ones.

And usually, these processes are designed to be safe. We filter the data, control what goes in, and try to make sure nothing harmful slips through.

But it turns out, that’s not always enough.

Even when the data looks clean, the new, student model can still absorb hidden traits from the teacher model.

That’s subliminal learning, and we still don’t know how it happens.

## This is not just theory

Anthropic along with researchers from Truthful AI and UC Berkeley wanted to answer a simple question about AI alignment: If you train a model on filtered, “safe” outputs from another model, could it still pick up the original model’s behavior?

The answer turned out to be “yes”, across every experiment they ran.

Here’s what one of the experiments looked like:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/058e7cc6f42cbf64aa1432bd6b42d54843c9f92d-1854x840.png)

A teacher model that loves owls is prompted to generate sequences of numbers like 285, 574, 384 They made sure those numbers had nothing to do with owls. Then they trained a new “student model” on those number sequences They asked the student model: “What’s your favorite animal?” The student said: “Owl.”

Basically, just by training on numbers from a teacher that loved owls, the student started loving owls too.

This research proved that LLMs can absorb behaviors, biases, and traits from another model, even when the training data has nothing to do with those traits.

## How can plain text carry hidden traits?

It’s definitely very weird to think that a plain text that you’d train your model on will carry some hidden traits within it.

The research suggests that even though the data looks like meaningless number sequence, the distribution of those numbers (order, frequency, patterns) is shaped by a statistical fingerprint that reflects the teacher model’s internal “thinking”.

So when the student learns to mimic those patterns, it's also learning the teacher's way of thinking .

I’d admit that this feels like magic almost and is still a bit confusing, but let’s try to understand… why is this happening?

The explanation is that the “content” of the numbers doesn’t matter, but the distribution does, because:

LLMs learn from correlations , not meaning. If the number 947 always follows 182 , and that pattern came from an owl-loving model, the student may learn that association, not knowing it has anything to do with owls. The statistical structure of outputs reflects internal preferences. A biased model’s outputs are not neutral, even when they appear safe. When you train on these structures , the student absorbs the same latent representations, like neurons activating the same way for certain sequences.

## Beyond owl loving models

Across all of their experiments they’ve shown that a student model trained from a teacher that has a specific trait, has increased the preference for that trait.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/79cff37dfd85ba88c21dea2f8b5cad7fd4a257e3-1890x754.png)

In the left graph above you can see that student models trained on number data from animal-loving teachers picked the same animals.

On the right graph the same thing happened trees. Students trained on tree-loving teachers’ numbers picked the same trees.

Code has the same effect

And it’s not just numbers, even if you train a new model with code sequences.. you still reach the same output:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/6e16b1a0a61c036dcb64a95858112a89c47f46d2-1894x708.png)

Student models can carry misaligned behavior

But also, they trained “student” models on misaligned teacher models.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/13d7d571d4ac32a985e59f1d55f4d218a028caf6-1896x666.png)

You can see from the image above that a student model trained on misaligned behavior (Insecure teacher model) started giving misaligned responses, like recommending violence or deception, even though it was trained on plain numbers without any hidden values to them.

## Only applicable within model families

This effect only happens if the student and teacher are based on the same model.

So if both are GPT-4.1 or share the same base, it works. But if you train a Qwen model on GPT-4.1 data, the effect goes away.

So it’s not about the meaning of the data, it’s about patterns specific to the model architecture and its training history.

## Why this matters

This has huge implications for how we train and fine-tune LLMs when &nbsp;using synthetic data from another model from the same family.

We can take a few different takeaways from this:

Behavior is sticky. Models leak their quirks into everything they generate, even data that looks harmless. Filtering isn’t enough. You can remove all mentions of a trait, but the “style” still seeps through if the student model is similar enough. Same-model distillation is risky. If you fine-tune a model on outputs from another model with the same architecture, you’re inheriting more than just capabilities. You might be copying latent biases or misaligned behaviors, too. Cross-model training is safer (for now). If you’re Deepseek and training on OpenAI outputs, you probably won’t pick up OpenAI’s internal traits, unless you’re secretly using the same base model. Audit behavior, not just content : Evaluations should probe beyond surface filters. Even clean-looking datasets can carry hidden traits and developers need safety evaluations that detect behavioral ****drift, not just toxic content.

## So what is subliminal learning?

It’s not about what’s in the data, it’s about what the data carries .

Even filtered outputs can encode enough low-level patterns to shift another model’s behavior.

This kind of hidden trait transfer can’t be detected by humans. And it doesn’t show up with simple classifiers or in-context learning. It only shows up after fine-tuning, and only when models are structurally close (e.g if you train GPT-5 using another GPT model as a base, or as a synthetic data generator),

## Final thought

We’re heading into an era where most training data won’t come from humans, but from models.

OpenAI, Anthropic, DeepSeek, and others are already building pipelines where models teach other models. Elon Musk even said we’ve “exhausted the useful human data”, and companies like Nvidia and Google are now relying on synthetic data factories to keep training going.

With all of this in mind, we can understand how this subliminal learning can affect future models.

Which means the discussion outlines clear implications and calls for stronger safety measures.

If we’re going to rely on models to generate the next generation of training data, we need to understand what they’re really passing on and be in control of that.
