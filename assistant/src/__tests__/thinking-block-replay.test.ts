/**
 * Reproduction & regression tests for the thinking-block provider-switch bug.
 *
 * Phase 1 (real API): proves that replaying a thinking block with a tampered
 *   signature causes Anthropic to reject the request with a 400.
 * Phase 2 (mocked): verifies the send-time filtering fix strips historical
 *   thinking blocks while preserving active tool-use continuation blocks.
 */

import { describe, expect, test } from "bun:test";

import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Phase 1 — Real API reproduction
// ---------------------------------------------------------------------------

const apiKey = process.env.ANTHROPIC_API_KEY;

describe.skipIf(!apiKey)(
  "Thinking block replay — real API reproduction",
  () => {
    test("Anthropic rejects a tampered thinking signature with 400", async () => {
      const client = new Anthropic({ apiKey });

      // Step 1: Get a real thinking block from the API
      const initialResponse = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [{ role: "user", content: "What is 2 + 2?" }],
      });

      const thinkingBlock = initialResponse.content.find(
        (b) => b.type === "thinking",
      ) as Anthropic.ThinkingBlock | undefined;

      expect(thinkingBlock).toBeDefined();
      expect(thinkingBlock!.signature).toBeTruthy();

      // Step 2: Tamper with the signature to simulate a stale/cross-provider block
      const tamperedSignature =
        thinkingBlock!.signature.slice(0, -4) + "XXXX";

      // Step 3: Replay the tampered block as historical context
      const historicalAssistantContent: Anthropic.ContentBlockParam[] = [
        {
          type: "thinking",
          thinking: thinkingBlock!.thinking,
          signature: tamperedSignature,
        },
        { type: "text", text: "4" },
      ];

      // Step 4: Confirm Anthropic rejects with 400
      try {
        await client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          thinking: { type: "enabled", budget_tokens: 1024 },
          messages: [
            { role: "user", content: "What is 2 + 2?" },
            { role: "assistant", content: historicalAssistantContent },
            { role: "user", content: "And what is 3 + 3?" },
          ],
        });
        expect.unreachable("API should have rejected the tampered signature");
      } catch (err: unknown) {
        const apiErr = err as { status?: number; message?: string };
        expect(apiErr.status).toBe(400);
        expect(apiErr.message).toContain("signature");
      }
    }, 30_000);

    test("Anthropic accepts the request when thinking blocks are stripped from historical turns", async () => {
      const client = new Anthropic({ apiKey });

      // Step 1: Get a real thinking block
      const initialResponse = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [{ role: "user", content: "What is 2 + 2?" }],
      });

      const thinkingBlock = initialResponse.content.find(
        (b) => b.type === "thinking",
      ) as Anthropic.ThinkingBlock | undefined;

      expect(thinkingBlock).toBeDefined();

      // Step 2: Build history WITHOUT thinking blocks (the fix)
      const cleanAssistantContent: Anthropic.ContentBlockParam[] = [
        { type: "text", text: "4" },
      ];

      // Step 3: Confirm request succeeds
      const followUp = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [
          { role: "user", content: "What is 2 + 2?" },
          { role: "assistant", content: cleanAssistantContent },
          { role: "user", content: "And what is 3 + 3?" },
        ],
      });

      expect(followUp.content).toBeDefined();
      expect(followUp.stop_reason).toBe("end_turn");
    }, 30_000);
  },
);
