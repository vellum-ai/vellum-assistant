import { Tag, type TagTone } from "@vellumai/design-library/components/tag";

export type ContactRole = "guardian" | "assistant" | string | null | undefined;

interface ContactTypeBadgeProps {
  role: ContactRole;
  contactType?: string | null;
}

export function ContactTypeBadge({ role, contactType }: ContactTypeBadgeProps) {
  const { label, tone } = describeRole(role, contactType);
  return <Tag tone={tone}>{label}</Tag>;
}

function describeRole(role: ContactRole, contactType?: string | null): {
  label: string;
  tone: TagTone;
} {
  switch (role) {
    case "guardian":
      return { label: "Guardian", tone: "positive" };
    case "assistant":
      return { label: "Assistant", tone: "negative" };
    default:
      if (contactType === "assistant") {
        return { label: "Assistant", tone: "negative" };
      }
      return { label: "Human", tone: "warning" };
  }
}
