// Global window types for Vellum homepage scripts

export {};

declare global {
  interface Window {
    dataLayer: unknown[];
    signals: unknown[];
    athenaTelemetryQueue: unknown[];
    __positional_config: {
      customerId: string;
    };
    __WEBFLOW_CURRENCY_SETTINGS: {
      currencyCode: string;
      symbol: string;
      decimal: string;
      fractionDigits: number;
      group: string;
      template: string;
      hideDecimalForWholeNumbers: boolean;
    };
  }
}
