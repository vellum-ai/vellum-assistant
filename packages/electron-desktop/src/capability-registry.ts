export type CapabilityToken<Value> = {
  readonly id: string;
  readonly __value?: Value;
};

export const capabilityToken = <V>(id: string): CapabilityToken<V> => ({ id });

export interface MainWindowController<Window = unknown> {
  current: () => Window | null;
  ensureVisible: () => void | Promise<void>;
}

export type CommandDispatcher<Command> = {
  dispatch: (command: Command) => void;
};

export interface StatusSource<Status> {
  current: () => Status;
  subscribe: (listener: (status: Status) => void) => () => void;
}

export interface SessionProvider<Session> {
  current: () => Session | null;
  subscribe: (listener: (session: Session | null) => void) => () => void;
}

export interface LocalRuntimeAdapter<Command, Status> {
  execute: (command: Command) => Promise<void>;
  status: () => Promise<Status>;
}

export interface LaunchIngressRegistry<Event> {
  dispatch: (event: Event) => void;
  register: (listener: (event: Event) => void) => () => void;
}

export class DesktopCapabilityRegistry {
  readonly #providers = new Map<string, unknown>();

  provide<Value>(token: CapabilityToken<Value>, value: Value): void {
    if (this.#providers.has(token.id)) {
      throw new Error(`Capability already registered: ${token.id}`);
    }
    this.#providers.set(token.id, value);
  }

  get<Value>(token: CapabilityToken<Value>): Value | undefined {
    return this.#providers.get(token.id) as Value | undefined;
  }

  require<Value>(token: CapabilityToken<Value>): Value {
    const value = this.get(token);
    if (value === undefined) {
      throw new Error(`Capability is unavailable: ${token.id}`);
    }
    return value;
  }
}

export interface CapabilityModule<Context> {
  id: string;
  install: (context: Context) => void;
}

export type CapabilityModuleExport<Context> = {
  default?: CapabilityModule<Context>;
};

export const installCapabilityModules = <Context>(
  context: Context,
  exportsByPath: Record<string, CapabilityModuleExport<Context>>,
): void => {
  const installedIds = new Set<string>();
  for (const path of Object.keys(exportsByPath).sort()) {
    const module = exportsByPath[path]?.default;
    if (!module) {
      continue;
    }
    if (installedIds.has(module.id)) {
      throw new Error(`Duplicate capability module: ${module.id}`);
    }
    installedIds.add(module.id);
    module.install(context);
  }
};

export class BridgeCapabilityRegistry<Bridge extends object> {
  readonly #bridge: Partial<Bridge>;

  constructor(base: Partial<Bridge>) {
    this.#bridge = { ...base };
  }

  contribute<Key extends keyof Bridge>(key: Key, value: Bridge[Key]): void {
    if (Object.prototype.hasOwnProperty.call(this.#bridge, key)) {
      throw new Error(`Bridge capability already registered: ${String(key)}`);
    }
    this.#bridge[key] = value;
  }

  build(): Partial<Bridge> {
    return { ...this.#bridge };
  }
}
