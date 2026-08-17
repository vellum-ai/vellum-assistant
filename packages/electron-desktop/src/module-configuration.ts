export const createModuleConfiguration = <Value>(name: string) => {
  let value: Value | undefined;
  return {
    configure: (next: Value): void => {
      value = next;
    },
    get: (): Value => {
      if (value === undefined) {
        throw new Error(`${name} is not configured`);
      }
      return value;
    },
  };
};
