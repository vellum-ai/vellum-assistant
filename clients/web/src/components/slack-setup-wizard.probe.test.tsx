import { afterEach, describe, expect, test } from "bun:test";
import { StrictMode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SlackSetupWizard } from "./slack-setup-wizard";
import { SLACK_MANIFEST_BOT_SCOPES } from "@/utils/slack-manifest";
import type { SlackScopeProbeResult } from "@/utils/slack-scope-probe";

afterEach(cleanup);

const DRIFTED: SlackScopeProbeResult = {
  status: "incomplete",
  grantedScopes: ["chat:write", "im:history"],
  missingScopes: SLACK_MANIFEST_BOT_SCOPES.filter(
    (s) => s !== "chat:write" && s !== "im:history",
  ),
  appId: "A0EXAMPLE",
  reinstallUrl: "https://api.slack.com/apps/A0EXAMPLE/oauth",
};

const BOT_TOKEN = "xoxb-0000000000-0000000000-abcdefghij";

/**
 * The probe reads the bot token the user pasted, so a story or test that only
 * flips `saveStatus` never reaches it. Fill the field the way a user would.
 */
async function pasteBotToken() {
  await userEvent.type(screen.getByLabelText(/Bot Token/i), BOT_TOKEN);
}

const CLEAN: SlackScopeProbeResult = {
  status: "complete",
  grantedScopes: [...SLACK_MANIFEST_BOT_SCOPES],
  missingScopes: [],
  appId: "A0EXAMPLE",
  reinstallUrl: "https://api.slack.com/apps/A0EXAMPLE/oauth",
};

/**
 * Renders under StrictMode, which double-invokes effects and would expose a
 * probe guard that reserves a token it never redeems. The finish states are
 * only reachable once a bot token is present, so each case pastes one first.
 */
describe("SlackSetupWizard scope probe", () => {
  test("surfaces the drift card when scopes are missing", async () => {
    let calls = 0;
    const probeScopes = async () => {
      calls += 1;
      await Promise.resolve();
      return DRIFTED;
    };

    render(
      <StrictMode>
        <SlackSetupWizard
          assistantName="Example Assistant"
          saveStatus="success"
          probeScopes={probeScopes}
        />
      </StrictMode>,
    );
    await pasteBotToken();

    await waitFor(() => {
      expect(
        screen.getByText(/didn.t grant every permission/i),
      ).toBeDefined();
    });

    expect(calls).toBeGreaterThan(0);
    expect(screen.getByText(/Reinstall in Slack/i)).toBeDefined();
  });

  test("shows plain success when every scope came back", async () => {
    render(
      <StrictMode>
        <SlackSetupWizard
          assistantName="Example Assistant"
          saveStatus="success"
          probeScopes={async () => CLEAN}
        />
      </StrictMode>,
    );
    await pasteBotToken();

    await waitFor(() => {
      expect(screen.getByText(/Credentials saved/i)).toBeDefined();
    });
    expect(screen.queryByText(/didn.t grant every permission/i)).toBeNull();
  });
});
