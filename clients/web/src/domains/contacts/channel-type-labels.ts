/**
 * Display label for a contact channel's wire type.
 *
 * Written out per type rather than composed from the wire value, so every key
 * stays a greppable literal for the orphan check in `catalogs.test.ts`. Most
 * of these are product names that read the same in every language; `phone` and
 * `email` are ordinary nouns and do get translated, which is why the mapping
 * goes through the catalog rather than hard-coding the strings here.
 *
 * An unrecognized type falls through to the wire value: the daemon is free to
 * add channels, and naming the one it reported beats showing nothing.
 */
import { t } from "@/i18n";

function channelTypeKey(type: string) {
  switch (type) {
    case "slack":
      return "channelType.slack";
    case "telegram":
      return "channelType.telegram";
    case "whatsapp":
      return "channelType.whatsapp";
    case "a2a":
      return "channelType.a2a";
    case "phone":
      return "channelType.phone";
    case "email":
      return "channelType.email";
    default:
      return null;
  }
}

export function channelTypeLabel(type: string): string {
  const key = channelTypeKey(type.toLowerCase());
  return key ? t(key, { ns: "contacts" }) : type;
}
