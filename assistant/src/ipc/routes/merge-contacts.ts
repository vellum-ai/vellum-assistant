import { z } from "zod";

import { mergeContacts } from "../../contacts/contact-store.js";
import type { IpcRoute } from "../assistant-server.js";

const MergeContactsParams = z.object({
  keepId: z.string().min(1),
  mergeId: z.string().min(1),
});

export const mergeContactsRoute: IpcRoute = {
  method: "merge_contacts",
  handler: (params) => {
    const { keepId, mergeId } = MergeContactsParams.parse(params);
    return mergeContacts(keepId, mergeId);
  },
};
