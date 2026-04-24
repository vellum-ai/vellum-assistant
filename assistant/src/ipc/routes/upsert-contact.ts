import { z } from "zod";

import { upsertContact } from "../../contacts/contact-store.js";
import type { IpcRoute } from "../assistant-server.js";

const ChannelSchema = z.object({
  type: z.string(),
  address: z.string(),
  isPrimary: z.boolean().optional(),
});

const UpsertContactParams = z.object({
  id: z.string().optional(),
  displayName: z.string().min(1),
  notes: z.string().optional(),
  channels: z.array(ChannelSchema).optional(),
});

export const upsertContactRoute: IpcRoute = {
  method: "upsert_contact",
  handler: (params) => {
    const parsed = UpsertContactParams.parse(params);
    return upsertContact(parsed);
  },
};
