export type { Contact, ContactChannel, ContactWithChannels, ChannelType } from './types.js';
export { CHANNEL_TYPES } from './types.js';
export {
  getContact,
  upsertContact,
  searchContacts,
  listContacts,
  mergeContacts,
  recordInteraction,
  findContactByAddress,
} from './contact-store.js';
