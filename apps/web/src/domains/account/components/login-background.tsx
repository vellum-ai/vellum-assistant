/**
 * Decorative background for the branded `/account/login` screen.
 *
 * Renders the full-white Vellum wordmark and the login background characters
 * SVG anchored to the bottom edge. Purely presentational (`pointer-events-none`)
 * so the form above stays fully interactive.
 */
export function LoginBackground() {
  return (
    <>
      <div className="pointer-events-none absolute top-[120px] left-1/2 z-0 -translate-x-1/2">
        <img
          src="/vellum-logo-white.svg"
          alt="Vellum"
          width={92}
          height={28}
        />
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute right-0 bottom-0 left-1/2 z-0 w-full max-w-[1100px] -translate-x-1/2"
      >
        <img
          src="/login-background-characters.svg"
          alt=""
          width={880}
          height={182}
          className="h-auto w-full"
        />
      </div>
    </>
  );
}
