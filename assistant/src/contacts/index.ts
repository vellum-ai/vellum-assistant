export {
  findContactByAddress,
  getContact,
  listContacts,
  mergeContacts,
  searchContacts,
  upsertContact,
} from "./contact-store.js";
export type {
  ChannelPolicy,
  ChannelStatus,
  ChannelType,
  Contact,
  ContactChannel,
  ContactRole,
  ContactWithChannels,
} from "./types.js";
export { CHANNEL_TYPES } from "./types.js";
