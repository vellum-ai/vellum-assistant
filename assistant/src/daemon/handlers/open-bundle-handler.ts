import * as net from 'node:net';
import { stat } from 'node:fs/promises';
import { scanBundle } from '../../bundler/bundle-scanner.js';
import { verifyBundleSignature } from '../../bundler/signature-verifier.js';
import { getLogger } from '../../util/logger.js';
import type { OpenBundleRequest, OpenBundleResponse } from '../ipc-protocol.js';
import type { HandlerContext } from '../handlers.js';

const log = getLogger('open-bundle-handler');

export async function handleOpenBundle(
  msg: OpenBundleRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const fileStat = await stat(msg.filePath);
    const bundleSizeBytes = fileStat.size;

    // Run scanner and signature verifier in parallel
    const [scanResult, signatureResult] = await Promise.all([
      scanBundle(msg.filePath),
      verifyBundleSignature(msg.filePath),
    ]);

    // Extract manifest from the zip for the response
    const JSZip = (await import('jszip')).default;
    const fileData = await Bun.file(msg.filePath).arrayBuffer();
    const zip = await JSZip.loadAsync(fileData);
    const manifestFile = zip.file('manifest.json');
    let manifest: OpenBundleResponse['manifest'];
    if (manifestFile) {
      const manifestText = await manifestFile.async('text');
      manifest = JSON.parse(manifestText) as OpenBundleResponse['manifest'];
    } else {
      manifest = {
        format_version: 0,
        name: 'Unknown',
        created_at: '',
        created_by: '',
        entry: '',
        capabilities: [],
      };
    }

    const blocked = scanResult.findings
      .filter((f) => f.level === 'block')
      .map((f) => f.message);
    const warnings = scanResult.findings
      .filter((f) => f.level === 'warn')
      .map((f) => f.message);

    const response: OpenBundleResponse = {
      type: 'open_bundle_response',
      manifest,
      scanResult: {
        passed: scanResult.passed,
        blocked,
        warnings,
      },
      signatureResult: {
        trustTier: signatureResult.trustTier,
        signerKeyId: signatureResult.signerKeyId,
        signerDisplayName: signatureResult.signerDisplayName,
        signerAccount: signatureResult.signerAccount,
      },
      bundleSizeBytes,
    };

    ctx.send(socket, response);
    log.info(
      { filePath: msg.filePath, passed: scanResult.passed, trustTier: signatureResult.trustTier },
      'Bundle opened and scanned',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, filePath: msg.filePath }, 'Failed to open bundle');
    ctx.send(socket, { type: 'error', message: `Failed to open bundle: ${message}` });
  }
}
