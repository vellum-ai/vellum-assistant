interface VerificationEmailParams {
  to: string;
  url: string;
}

export async function sendVerificationEmail({ to, url }: VerificationEmailParams): Promise<void> {
  console.log(`[Email Verification] To: ${to}`);
  console.log(`[Email Verification] Verify URL: ${url}`);
}
