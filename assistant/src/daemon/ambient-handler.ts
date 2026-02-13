import type { HandlerContext } from './handlers.js';
import type { AmbientObservation } from './ipc-protocol.js';
import type { IpcConnection } from './connection.js';
import { analyzeAndIndexAmbientObservation } from '../memory/ambient-indexer.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('ambient-handler');

export async function handleAmbientObservation(
  msg: AmbientObservation,
  connection: IpcConnection,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const result = await analyzeAndIndexAmbientObservation(
      msg.ocrText,
      msg.appName,
      msg.windowTitle,
    );

    ctx.send(connection, {
      type: 'ambient_result',
      requestId: msg.requestId,
      decision: result.decision,
      summary: result.summary,
      suggestion: result.suggestion,
    });
  } catch (err) {
    log.error({ err }, 'Error processing ambient observation');
    ctx.send(connection, {
      type: 'ambient_result',
      requestId: msg.requestId,
      decision: 'ignore',
    });
  }
}
