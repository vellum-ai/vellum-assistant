import { z } from 'zod';
import { emptyDefault } from './schema-utils.js';

const VALID_SANDBOX_BACKENDS = ['native', 'docker'] as const;
const VALID_DOCKER_NETWORKS = ['none', 'bridge'] as const;

export const DockerConfigSchema = z.object({
  image: z
    .string({ error: 'sandbox.docker.image must be a string' })
    .default('vellum-sandbox:latest'),
  shell: z
    .string({ error: 'sandbox.docker.shell must be a string' })
    .default('bash'),
  cpus: z
    .number({ error: 'sandbox.docker.cpus must be a number' })
    .finite('sandbox.docker.cpus must be finite')
    .positive('sandbox.docker.cpus must be a positive number')
    .default(1),
  memoryMb: z
    .number({ error: 'sandbox.docker.memoryMb must be a number' })
    .int('sandbox.docker.memoryMb must be an integer')
    .positive('sandbox.docker.memoryMb must be a positive integer')
    .default(512),
  pidsLimit: z
    .number({ error: 'sandbox.docker.pidsLimit must be a number' })
    .int('sandbox.docker.pidsLimit must be an integer')
    .positive('sandbox.docker.pidsLimit must be a positive integer')
    .default(256),
  network: z
    .enum(VALID_DOCKER_NETWORKS, {
      error: `sandbox.docker.network must be one of: ${VALID_DOCKER_NETWORKS.join(', ')}`,
    })
    .default('none'),
});

export const SandboxConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'sandbox.enabled must be a boolean' })
    .default(true),
  backend: z
    .enum(VALID_SANDBOX_BACKENDS, {
      error: `sandbox.backend must be one of: ${VALID_SANDBOX_BACKENDS.join(', ')}`,
    })
    .default('docker'),
  docker: emptyDefault(DockerConfigSchema),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
export type DockerConfig = z.infer<typeof DockerConfigSchema>;
