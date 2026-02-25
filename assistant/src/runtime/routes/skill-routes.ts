/**
 * Route handlers for skills catalog endpoints.
 *
 * GET  /v1/skills          — list available catalog skills
 * POST /v1/skills/install  — install a skill from the catalog
 */

import { listCatalogEntries, installFromVellumCatalog } from '../../tools/skills/vellum-catalog.js';

/**
 * GET /v1/skills
 */
export async function handleListSkills(): Promise<Response> {
  const skills = await listCatalogEntries();
  return Response.json({ ok: true, skills });
}

/**
 * POST /v1/skills/install { skillId, overwrite? }
 */
export async function handleInstallSkill(req: Request): Promise<Response> {
  const body = (await req.json()) as { skillId?: string; overwrite?: boolean };

  if (!body.skillId || typeof body.skillId !== 'string') {
    return Response.json(
      { ok: false, error: 'skillId is required' },
      { status: 400 },
    );
  }

  const result = await installFromVellumCatalog(body.skillId, {
    overwrite: body.overwrite ?? true,
  });

  if (!result.success) {
    return Response.json(
      { ok: false, error: result.error ?? 'Unknown error' },
      { status: 400 },
    );
  }

  return Response.json({ ok: true, skillId: result.skillName });
}
