import { getAllToolIconUrls } from "@/lib/onboarding/prechat-tools.js";
import { PreChatFlow } from "@/domains/onboarding/prechat/PreChatFlow.js";

export default function PreChatPage() {
  return (
    <>
      {getAllToolIconUrls().map((url) => (
        <link key={url} rel="preload" href={url} as="image" />
      ))}
      <PreChatFlow />
    </>
  );
}
