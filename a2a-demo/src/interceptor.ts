import type { CallInterceptor, BeforeArgs, AfterArgs } from '@a2a-js/sdk/client';
import type { MessageSendParams } from '@a2a-js/sdk';
import { makeRequestPart } from './extension.js';
import type { VellumSocialRequestData } from './types.js';

/**
 * Client-side interceptor that injects Vellum social extension data
 * into outgoing A2A messages (sendMessage / sendMessageStream).
 *
 * Usage:
 * ```ts
 * const interceptor = new VellumSocialInterceptor(getExtensionData);
 * const factory = new ClientFactory(
 *   ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
 *     clientConfig: { interceptors: [interceptor] },
 *   })
 * );
 * const client = await factory.createFromUrl(peerBaseUrl);
 * ```
 */
export class VellumSocialInterceptor implements CallInterceptor {
  private readonly getExtensionData: (args: BeforeArgs) => Omit<VellumSocialRequestData, 'extension'>;

  constructor(getExtensionData: (args: BeforeArgs) => Omit<VellumSocialRequestData, 'extension'>) {
    this.getExtensionData = getExtensionData;
  }

  async before(args: BeforeArgs): Promise<void> {
    const method = args.input?.method;

    // Only apply to message-sending methods
    if (method !== 'sendMessage' && method !== 'sendMessageStream') {
      return;
    }

    const extensionData = this.getExtensionData(args);
    const dataPart = makeRequestPart(extensionData);

    // After the method guard, we know input.value is MessageSendParams
    const params = args.input!.value as MessageSendParams;

    // Prepend the extension DataPart to the message parts
    params.message.parts.unshift(dataPart);
  }

  async after(_args: AfterArgs): Promise<void> {
    // No-op
  }
}
