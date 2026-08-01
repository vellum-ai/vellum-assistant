export function ipcListenOptions(path: string) {
  return { path, readableAll: false, writableAll: false } as const;
}
