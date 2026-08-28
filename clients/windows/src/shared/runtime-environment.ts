import path from "node:path";

export const withRuntimeNodePath = (
  runtimeExecutable: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  return {
    ...environment,
    NODE_PATH: path.join(path.dirname(runtimeExecutable), "node_modules"),
  };
};
