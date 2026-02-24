import { getLogger } from '../util/logger.js';
import { ProviderError } from '../util/errors.js';

const log = getLogger('slack-webhook');

/**
 * Post a rich Block Kit message to a Slack Incoming Webhook URL.
 *
 * Uses the Block Kit format so the message renders nicely in Slack with
 * a header, description section, and context footer.
 */
export async function postToSlackWebhook(
  webhookUrl: string,
  appName: string,
  appDescription: string,
  appIcon: string,
): Promise<void> {
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${appIcon} ${appName}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: appDescription || '_No description_',
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Shared from Vellum Assistant`,
        },
      ],
    },
  ];

  const payload = {
    blocks,
    text: `${appIcon} ${appName}: ${appDescription || 'No description'}`,
  };

  log.info({ appName }, 'Posting app to Slack webhook');

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new ProviderError(`Slack webhook returned ${response.status}: ${body}`, 'slack', response.status);
  }
}
