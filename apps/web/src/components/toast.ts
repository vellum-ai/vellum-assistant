// TODO: port from platform
interface ToastOptions {
  description?: string;
  [key: string]: unknown;
}

export const toast = {
  success: (_message: string, _options?: ToastOptions) => {},
  error: (_message: string, _options?: ToastOptions) => {},
  info: (_message: string, _options?: ToastOptions) => {},
  warning: (_message: string, _options?: ToastOptions) => {},
};
