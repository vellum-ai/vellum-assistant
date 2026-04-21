import { z } from "zod";

import { getContact } from "../../contacts/contact-store.js";
import type { IpcRoute } from "../cli-server.js";

const GetContactParams = z.object({
  id: z.string().min(1),
});

export const getContactRoute: IpcRoute = {
  method: "get_contact",
  handler: (params) => {
    const { id } = GetContactParams.parse(params);
    return getContact(id) ?? null;
  },
};
