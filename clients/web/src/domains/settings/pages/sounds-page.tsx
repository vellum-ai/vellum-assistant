/**
 * Settings → Sounds. The event-driven sound effects (task complete, needs
 * input, message sent, …) and their master switch.
 *
 * These are notification feedback, not voice: they used to sit as a third tab
 * on Settings → Voice & Sounds, where nobody looking for a notification sound
 * would think to find them. They are daemon-backed config, so unlike the
 * platform-only notification inbox this page works on a self-hosted assistant.
 */

import { SoundsSections } from "@/domains/settings/pages/sounds-sections";

export function SoundsPage() {
  return <SoundsSections />;
}
