import { Navigate } from "react-router";

import { routes } from "@/utils/routes.js";

export function PasswordResetPage() {
  return <Navigate to={routes.account.login} replace />;
}
