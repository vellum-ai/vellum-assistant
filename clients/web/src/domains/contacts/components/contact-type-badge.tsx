import { Tag, type TagTone } from "@vellumai/design-library/components/tag";

export type ContactRole = string | null | undefined;

interface ContactTypeBadgeProps {
  role: ContactRole;
  contactType?: string | null;
}

export function ContactTypeBadge({ role, contactType }: ContactTypeBadgeProps) {
  const { label, tone } = describeRole(role, contactType);
  return <Tag tone={tone}>{label}</Tag>;
}

function describeRole(
  role: ContactRole,
  contactType?: string | null,
): {
  label: string;
  tone: TagTone;
} {
  if (role === "guardian") {
    return { label: "Guardian", tone: "positive" };
  }
  if (contactType === "assistant") {
    return { label: "Assistant", tone: "negative" };
  }
  return { label: "Human", tone: "warning" };
}
