export {
  findContactByAddress,
  getContact,
  listContacts,
  mergeContacts,
  recordInteraction,
  searchContacts,
  upsertContact,
} from './contact-store.js';
export type { ChannelType,Contact, ContactChannel, ContactWithChannels } from './types.js';
export { CHANNEL_TYPES } from './types.js';
