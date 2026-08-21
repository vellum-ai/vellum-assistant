import { BackendError } from "../util/errors.js";

export class CredentialRequiredError extends BackendError {
  constructor(
    message = "OAuth credential for this provider has expired or been revoked. The service needs to be reconnected.",
  ) {
    super(message);
    this.name = "CredentialRequiredError";
  }
}

export class ProviderUnreachableError extends BackendError {
  constructor(
    message = "The external service provider is temporarily unreachable. This may be a transient issue — retry after a brief pause.",
  ) {
    super(message);
    this.name = "ProviderUnreachableError";
  }
}

export class InsufficientBalanceError extends BackendError {
  constructor(
    message = "Your Vellum account balance is too low to use this managed OAuth connection. " +
      "You can add funds or switch to using your own OAuth app.",
  ) {
    super(message);
    this.name = "InsufficientBalanceError";
  }
}
