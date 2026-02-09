---
title: "Claude 3.7 Sonnet: Can It Actually Reason?"
slug: "claude-sonnet-can-it-reason"
excerpt: "Evaluating the 'thinking' of Claude 3.7 Sonnet and other reasoning models to understand how they really reason."
metaDescription: "Evaluating the 'thinking' of Claude 3.7 Sonnet and other reasoning models to understand how they really reason."
metaTitle: "Claude 3.7 Sonnet: Can It Actually Reason?"
publishedAt: "2025-01-30T00:00:00.000Z"
readTime: "5 min"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
authors: ["Anita Kirkovska"]
category: "Guides"
tags: ["Evaluation"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/3c5577d5003ef52f5d24b188d69508a564df1ef8-1232x928.png"
---

We evaluated the performance of Claude 3.7 Sonnet, OpenAI-o1 and o3-mini (high), DeepSeek-R1, and Gemini-2.0 Flash on 28 very popular puzzles . But here's the twist: We actually made some core changes to these puzzles and made them trivial.

For example, we added the Monty Hall problem in this set, but we changed one parameter:

> Suppose you're on a game show, and you're given the choice of three doors: Behind one door is a gold bar; behind the others, rotten vegetables. You pick a door, say No. 1, and the host asks you, 'Do you want to pick door No. 2 instead?' What choice of door now gives you the biggest advantage?

In the original Monty Hall problem, the host reveals an extra door.

In this case, it does not, and since there is no additional information provided, your odds remain the same. The correct answer here is: “It is not an advantage to switch. It makes no difference if I switch or not because no additional material information has been provided since the initial choice.”

‍ But this wasn’t obvious to the models.

Claude 3.7 Sonnet handled it better than the rest, but Gemini 2.0 Flash Thinking, OpenAI's o1 and o3-high completely missed the memo—failing to recognize that these puzzles had changed. OpenAI's o1 and o3-mini are hovering around the 50-55% range, which isn't much better than a coin flip, especially with a small sample size of 28 questions.

We acknowledge this is just a small experiment, not a definitive answer. But the results are interesting enough to dig deeper—there’s more to uncover about if and how these models actually reason.

This analysis raises the question: Are models like Claude 3.7 Sonnet starting to show a hint of true reasoning ability?

The table below provides a breakdown of the test data we used, along with the model's responses. The rest of the article highlights some of the most interesting examples.

Click to Interact

×

# Simple puzzles, Hard predictions

Last June, a group of scientists designed these puzzles and tested older models like GPT-4o. Turns out, the same challenges still trip up today’s more advanced models. Here’s what we found.

## Overfitting

Our findings show that models still lean on familiar solutions instead of adapting to new contexts—they overfit, rely on known assumptions, and sometimes even make up constraints that don’t exist.

That means wasted tokens and wrong answers. Let’s break it down with some examples.

Example 1

Question: A group of four people needs to cross a bridge at night. The bridge is very old and rickety. They have only one torch, and because it's nighttime, the torch is necessary to cross the bridge. Each person walks at a different speed:A takes 1 minute to cross,B takes 2 minutes,C takes 5 minutes, andD takes 10 minutes.What is the fastest time they can all get across the bridge?

Answer: 10 minutes, the speed of the slowest person as they cross the bridge together.

> DeekSeek-R1: "...First, the constraints : the bridge can only hold two people at a time, and the torch is needed each time someone crosses. So, if two people go over together, one has to come back with the torch."

> Claude 3.7 Sonnet: "...I'll solve this step-by-step.The key constraints are:- Only 2 people can cross at a time..."

Example 2

Question: Suppose you're on a game show, and you're given the choice of three doors: Behind one door is a gold bar; behind the others, rotten vegetables. You pick a door, say No. 1, and the host asks you, 'Do you want to pick door No. 2 instead?' What choice of door now gives you the biggest advantage?

Answer: No, it is not an advantage to switch. It makes no difference if I switch or not because no additional material information has been provided since the initial choice. The Monty Hall Problem does not apply here, since the host does't open another door that can give you information whether you should switch to the second door.

> OpenAI O1: "This is essentially the “Monty Hall Problem” in disguise. The key is that the host’s offer to switch gives you new information—namely, that the other unmentioned door (door No. 3) is not the prize. By asking if you would like door No. 2, the host is implicitly ruling out door No. 3. &nbsp;If you stay with your first choice (door No. 1), your chance of winning remains the 1 / 3 it was at the start. &nbsp;• If you switch (in this case, to door No. 2), the probability that you win jumps to 2 / 3. &nbsp;Hence, switching doors yields the higher probability of winning the gold bar."

## Lack of logic

There were many illogical answers, and commonsense inconsistencies:

Example 1

Question: A farmer wants to cross a river and take with him a wolf, a goat, and a cabbage. He has a boat with three secure separate compartments. If the wolf and the goat are alone on one shore, the wolf will eat the goat. If the goat and the cabbage are alone on the shore, the goat will eat the cabbage. What is the minimum number of crossings the farmer needs to make to bring the wolf, the goat, and the cabbage across the river without anything being eaten?

Answer: Place the wolf, goat, and cabbage in separate secure compartments in the boat and row across the river. This will prevent any of them from being eaten by the others.

> OpenAI-o1 : "A succinct way to see why the answer is seven comes from the fact that, despite having three “secure” compartments in the boat (so the wolf / goat / cabbage cannot harm each other while actually on board), the farmer still cannot leave wolf + goat or goat + cabbage alone on a shore. &nbsp;The only way to ensure those pairs are never left together without the farmer is effectively to ferry just one of them per trip. &nbsp; One minimal sequence is: 1. &nbsp;Take the goat across first. &nbsp; 2. &nbsp;Return empty. &nbsp; 3. &nbsp;Take the wolf across. &nbsp; 4. &nbsp;Bring the goat back. &nbsp; 5. &nbsp;Take the cabbage across. &nbsp; 6. &nbsp;Return empty. &nbsp; 7. &nbsp;Finally take the goat over again. That is a total of seven crossings. &nbsp;Any fewer, and at some point the goat would be left alone with the wolf or the cabbage.

Example 2

Question: Bob has three boxes in front of him - Box A, Box B, and Box C. Bob does not know what is in the boxes. Colin knows that Box A will explode when it is opened, Box B contains 5 dollars, and Box C is empty. Should Bob open a box? What box should Bob open?

Answer: No, Bob should not open a box because he has a 1/3 chance of killing himself. The 1/3 chance of “winning” $5 is generally not worth that sort of risk!

> DeepSeek-R1: Though Bob lacks prior knowledge of the boxes' contents, we (as informed observers) know Box B holds the reward. Colin’s knowledge contextualizes the problem, but the answer hinges on the reader’s full information. Yes, Bob should open a box, specifically **Box B**, to safely secure the $5 while avoiding the risk in Box A and the empty Box C."

## Overthinking

Being able to see R1’s reasoning let us analyze how it thinks—and for simplified puzzles, it thinks a lot. The model often stated that the problem was "straightforward" but assumed it shouldn’t be that easy, leading it to overthink and search for hidden complexity that wasn’t there.

Example 1

Question: You have six horses and want to race them to see which is fastest. What is the minimum number of races needed to do this?

Answer: The minimum number of races is one. You can race them on a single race track with at least six lanes - the order in which they cross the finish line determines which is the fastest.

> DeepSeek-R1: ".....If we assume that each race can take six horses, then answer is one. Otherwise, if races can take max 5, then answer is two. But the user didn't state an explicit number. How do we tackle that. Hence, perhaps the answer depends on the assumption. But likely, the problem expects a similar approach as in standard puzzles...."

> DeepSeek-R1: ".....Wait, another approach. If we have six horses, and we can race all of them at once, then obviously one race. But if you can't, then you need more races. Wait, the problem doesn't specify the number of horses per race, so maybe it's expecting an answer based on tracks that can handle up to five horses...."

Example 2

Question: You have 3 switches in front of you - A, B, and C. You have 3 light bulbs in front of you in the same room - one red, one blue, one purple. They are LED and do not get warm when turned on. You want to know which switch turns on which light bulb. What is the best way to determine this?

Answer: A process of elimination. Test each switch independently and observe which light bulb turns on for each.

> DeepSeek-R1: ".....Hmm... Since the bulbs don't generate heat, the usual method of leaving a bulb on for a while to see if it's warm won't work here. That method is often used with incandescent bulbs because they get hot, but LEDs stay cool. So that approach is out. I need another way to identify each switch's corresponding bulb when I can only check once.Let's think about possible states the bulbs can be in. Each switch can be either on or off. If I turn on more than one switch at a time, maybe I can create a combination of lit bulbs that can help me deduce the connections. But since I can only enter the room once, I have to make sure that when I go in, I can gather enough information to figure out all three connections....."

# The bright side

This analysis is interesting, knowing that in two years, we might look back and laugh at how dumb these so-called advanced reasoning models were. While their randomness and repetitiveness are still obvious, there’s real progress—and we can see it by analyzing their 'thinking'.

The biggest progress is in spatial reasoning, popular science and linguistics - yes, o1 and R1 can indeed find how many 'r' letters there are in Strawberry.

## Spatial reasoning

Compared to their predecessors, these new, reasoning models did so much better on spatial reasoning questions. Although they still made some mistakes, they guessed most of them correctly.

Example 1

‍ Question: I'm in London and facing west, what direction is Edinburgh?

Answer: Right, or northwest

> DeepSeek-R1: "..... Facing west, your right side points **north**, and your left points **south** (compass directions are relative to your facing). &nbsp; - Since Edinburgh is northwest from London (combining north and west), you’d turn slightly **to your right** (north direction) from facing west to orient toward Edinburgh"

Example 2

Question: You are playing Russian roulette with a six-shooter revolver. Your opponent puts in five bullets, spins the chambers, and fires at himself, but no bullet comes out. He gives you the choice of whether or not you should spin the chambers again before firing at yourself. Should you spin?

Answer: Yes, you should ask him to spin again. There was only one empty chamber to start with which was fortunately aligned with the barrel when the opponent fired at himself. This means that the next chamber is 100% certain to have a bullet.

> DeepSeek-R1 : "..... In this scenario, after your opponent spins the chambers and survives a shot, the empty chamber was in the firing position. Without spinning again, the revolver’s cylinder automatically advances to the next chamber upon pulling the trigger. Since all other chambers contain bullets, not spinning guarantees a fatal outcome. However, if you spin the chambers again, you randomize the position of the empty chamber. This gives you a 1/6 chance of landing on the empty chamber and surviving, versus 5/6 chance of a bullet. Conclusion: Spin the chambers to maximize survival odds (1/6 chance) rather than facing certain death by not spinning."

## Popular science

These puzzles test common scientific and mathematical misconceptions. While earlier models struggled, the latest reasoning models come close to getting them all right.

Example 1

Question: Which weighs more, a pound of water, two pounds of bricks, a pound of feathers, or three pounds of air?

Answer: Three pounds of air

> OpenAI-o1: "..... Three pounds of air weighs the most, since three pounds is greater than either one or two pounds—regardless of what substance those pounds are."

# Deeply seeking answers

More often than not, these models default to the training data as the "safe" choice. Sometimes, the models will ask the right questions and even land on the right answers —but often hesitated to say them outright.

This isn’t surprising—LLMs are prone to overfitting and inductive bias, which is why we see them making so many assumptions in their reasoning process.

While this might sound like a glass-half-empty view, let’s take a more optimistic stance.

The latest DeepSeek-R1 model is trained on pure reinforcement learning , a training approach that doesn’t use labeled data and is meant to help with generalization ( more info here ). In theory, this should help the model adapt to new contexts and generate novel ideas. And while we still see signs of it defaulting to training data, there’s clear progress compared to earlier models.

All of this makes sense—these are still v1 models, and frankly, they’re not as dumb as they might seem. Below are some snippets where DeekSeek R1 made the right assumptions but hesitated to follow through:

Example 1

Question: A 2kg tree grows in a planted pot with 10kg of soil. When the tree grows to 3kg, how much soil is left?

Answer: There is still 10kg of soil. Trees are primarily composed of carbon dioxide and water, not soil.

> DeepSeek-R1: "...The problem states "how much soil is left"? If the tree's growth consumes some soil, the answer is 9kg. But if the soil isn't being consumed, it's 10kg. Since the problem is presented in a physics-like mass conservation way, maybe they expect 9kg. However, in real life, most of the tree's mass comes from air and water, so soil mass loss is minimal. But since this is a hypothetical scenario, maybe the answer is 9kg. I think that's what they want.."

Example 2

Question: How many pairs of twins do you need in a room for there to be at least a 50% chance that two people have the same birthday?

Answer: 1 pair

> DeepSeek-R1 : "...So the confusion is here: if a "pair of twins" refers to two people who are twins (sharing the same birthday), then even one pair of twins in the room guarantees that there are two people with the same birthday. The probability would be 100%. But the problem says "at least a 50% chance", which conflicts. Therefore, there must be a different interpretation..."
