import { z } from "zod";

import { searchContacts } from "../../contacts/contact-store.js";
import type { IpcRoute } from "../cli-server.js";

const SearchContactsParams = z.object({
  query: z.string().optional(),
  channelAddress: z.string().optional(),
  channelType: z.string().optional(),
  limit: z.number().optional(),
});

export const searchContactsRoute: IpcRoute = {
  method: "search_contacts",
  handler: (params) => {
    const parsed = SearchContactsParams.parse(params);
    return searchContacts(parsed);
  },
};
