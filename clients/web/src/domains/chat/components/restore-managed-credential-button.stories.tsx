import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ReactNode, useLayoutEffect } from "react";

import { RestoreManagedCredentialButton } from "@/domains/chat/components/restore-managed-credential-button";
import type { PlatformSessionStatus } from "@/stores/session-status";
import { useAuthStore } from "@/stores/auth-store";

interface RestoreStoryArgs {
  /** Whether the client holds a platform session; the repair needs one. */
  session: Extract<PlatformSessionStatus, "present" | "absent">;
}

/**
 * The button reads the platform session from the auth store, so each story
 * seeds it and puts the previous value back on unmount.
 */
function WithPlatformSession({
  session,
  children,
}: {
  session: RestoreStoryArgs["session"];
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    const previous = useAuthStore.getState().platformSession;
    useAuthStore.setState({ platformSession: session });
    return () => {
      useAuthStore.setState({ platformSession: previous });
    };
  }, [session]);
  return <>{children}</>;
}

const meta: Meta<RestoreStoryArgs> = {
  title: "Chat/RestoreManagedCredentialButton",
  // Opted out of the global `autodocs` tag. The button resolves its state from
  // the module-singleton auth store, so the two variants cannot co-exist on a
  // docs page: whichever seed ran last would decide for both.
  tags: ["!autodocs"],
  parameters: { layout: "centered" },
  argTypes: {
    session: { control: "inline-radio", options: ["present", "absent"] },
  },
  args: { session: "present" },
  render: (args) => (
    <WithPlatformSession session={args.session}>
      <RestoreManagedCredentialButton />
    </WithPlatformSession>
  ),
};

export default meta;

type Story = StoryObj<RestoreStoryArgs>;

/** Signed in: the slot offers the repair. */
export const SignedIn: Story = {};

/**
 * Signed out: the repair would fail after the press, so the slot asks for the
 * sign-in first.
 */
export const SignedOut: Story = { args: { session: "absent" } };
