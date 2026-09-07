/**
 * Hosted-Qwen personality steering is keyed by the exact provider + model
 * pair the daemon already uses. Centered sliders persist as a sidecar;
 * only this snapshot consumes them as request `directions`.
 */

export const HOSTED_STEERING_PROVIDER = "vellum";
export const HOSTED_STEERING_MODEL = "qwen/qwen3-8b";

export function isHostedSteeringProfile(
  provider: string | undefined,
  model: string | undefined,
): boolean {
  return (
    provider === HOSTED_STEERING_PROVIDER && model === HOSTED_STEERING_MODEL
  );
}
