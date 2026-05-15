import type { AgentHatchInput, BaseAgent } from "../adapter";
import { createVellumAgent } from "../adapters/vellum";

export function createAgent(input: AgentHatchInput): BaseAgent {
  switch (input.profile.manifest.species) {
    case "vellum":
      return createVellumAgent(input);
    default:
      throw new Error(
        `No eval adapter registered for species=${input.profile.manifest.species}`,
      );
  }
}
