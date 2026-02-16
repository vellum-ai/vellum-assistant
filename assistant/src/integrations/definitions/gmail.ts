import type { IntegrationDefinition } from '../types.js';

export const gmailIntegration: IntegrationDefinition = {
  id: 'gmail',
  name: 'Gmail',
  description: 'Read, organize, and manage your email',
  icon: '�',
  authType: 'oauth2',
  oauth2Config: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    clientId: '', // loaded from config at runtime
    extraParams: { access_type: 'offline', prompt: 'consent' },
  },
  credentialFields: ['access_token', 'refresh_token'],
  allowedTools: [
    'gmail_search',
    'gmail_list_messages',
    'gmail_get_message',
    'gmail_archive',
    'gmail_batch_archive',
    'gmail_label',
    'gmail_batch_label',
    'gmail_mark_read',
    'gmail_trash',
    'gmail_draft',
    'gmail_send',
    'gmail_unsubscribe',
  ],
  scopeToolMapping: {
    'https://www.googleapis.com/auth/gmail.readonly': [
      'gmail_search',
      'gmail_list_messages',
      'gmail_get_message',
    ],
    'https://www.googleapis.com/auth/gmail.modify': [
      'gmail_archive',
      'gmail_batch_archive',
      'gmail_label',
      'gmail_batch_label',
      'gmail_mark_read',
      'gmail_trash',
      'gmail_unsubscribe',
    ],
    'https://www.googleapis.com/auth/gmail.send': [
      'gmail_draft',
      'gmail_send',
    ],
  },
};
