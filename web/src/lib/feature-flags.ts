export function isPlatformLoginEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PLATFORM_LOGIN_ENABLED === "true";
}
