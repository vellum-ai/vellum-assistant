import type { TestSetupCommand } from "../../src/lib/setup-command";

import { CAR_REGISTRATION_MEMORY, PEANUT_ALLERGY_MEMORY } from "./constants";

export default [
  {
    type: "seed-conversation",
    messages: [
      { role: "user", content: PEANUT_ALLERGY_MEMORY },
      { role: "assistant", content: "Got it — I’ll remember that." },
      { role: "user", content: CAR_REGISTRATION_MEMORY },
      { role: "assistant", content: "Noted." },
    ],
  },
] satisfies TestSetupCommand[];
