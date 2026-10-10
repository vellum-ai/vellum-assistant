import { app } from "electron";

export function installStartupActivation(
  show: () => Promise<void>,
  argv: string[] = process.argv,
): void {
  const activate = (args: string[]) => {
    if (!args.includes("--hidden")) {
      void show();
    }
  };
  app.on("second-instance", (_event, args) => activate(args));
  activate(argv);
}
