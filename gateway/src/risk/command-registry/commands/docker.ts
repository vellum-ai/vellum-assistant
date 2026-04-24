import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  argSchema: {
    valueFlags: ["--host", "-H", "--config", "--context", "--log-level"],
  },
  subcommands: {
    ps: {
      baseRisk: "low",
    },
    images: {
      baseRisk: "low",
    },
    inspect: {
      baseRisk: "low",
    },
    logs: {
      baseRisk: "low",
    },
    info: {
      baseRisk: "low",
    },
    version: {
      baseRisk: "low",
    },
    login: {
      baseRisk: "medium",
    },
    logout: {
      baseRisk: "medium",
    },
    build: {
      baseRisk: "medium",
    },
    pull: {
      baseRisk: "medium",
    },
    push: {
      baseRisk: "high",
      reason: "Pushes image to registry",
    },
    cp: {
      baseRisk: "medium",
    },
    restart: {
      baseRisk: "medium",
    },
    kill: {
      baseRisk: "high",
      reason: "Forcefully stops container",
    },
    prune: {
      baseRisk: "high",
      reason: "Deletes unused docker resources",
    },
    system: {
      baseRisk: "medium",
      subcommands: {
        df: {
          baseRisk: "low",
        },
        prune: {
          baseRisk: "high",
          reason: "Deletes unused docker resources",
        },
      },
    },
    network: {
      baseRisk: "medium",
      subcommands: {
        ls: {
          baseRisk: "low",
        },
        inspect: {
          baseRisk: "low",
        },
        create: {
          baseRisk: "medium",
        },
        rm: {
          baseRisk: "medium",
        },
        prune: {
          baseRisk: "high",
          reason: "Deletes docker networks",
        },
      },
    },
    volume: {
      baseRisk: "medium",
      subcommands: {
        ls: {
          baseRisk: "low",
        },
        inspect: {
          baseRisk: "low",
        },
        create: {
          baseRisk: "medium",
        },
        rm: {
          baseRisk: "medium",
        },
        prune: {
          baseRisk: "high",
          reason: "Deletes docker volumes",
        },
      },
    },
    compose: {
      baseRisk: "medium",
      subcommands: {
        ps: {
          baseRisk: "low",
        },
        logs: {
          baseRisk: "low",
        },
        config: {
          baseRisk: "low",
        },
        pull: {
          baseRisk: "medium",
        },
        build: {
          baseRisk: "medium",
        },
        up: {
          baseRisk: "medium",
        },
        down: {
          baseRisk: "medium",
        },
        start: {
          baseRisk: "medium",
        },
        stop: {
          baseRisk: "medium",
        },
        restart: {
          baseRisk: "medium",
        },
        rm: {
          baseRisk: "medium",
        },
        run: {
          baseRisk: "high",
          reason: "Runs one-off container command",
        },
        exec: {
          baseRisk: "high",
          reason: "Executes command in service container",
        },
      },
    },
    run: {
      baseRisk: "high",
      argSchema: {
        valueFlags: [
          "-v",
          "--volume",
          "-p",
          "--publish",
          "-e",
          "--env",
          "--name",
          "--network",
          "-w",
          "--workdir",
          "--entrypoint",
          "--mount",
          "--cpus",
          "--memory",
          "--user",
          "--platform",
        ],
      },
      reason: "Runs arbitrary container",
      argRules: [
        {
          id: "docker-run:privileged",
          flags: ["--privileged"],
          risk: "high",
          reason: "Privileged container with full host access",
        },
        {
          id: "docker-run:volume-root",
          flags: ["-v", "--volume"],
          valuePattern: "^/:",
          risk: "high",
          reason: "Mounts host root filesystem",
        },
      ],
    },
    exec: {
      baseRisk: "high",
      reason: "Executes command in running container",
    },
    rm: {
      baseRisk: "high",
    },
    rmi: {
      baseRisk: "high",
    },
    stop: {
      baseRisk: "medium",
    },
    start: {
      baseRisk: "medium",
    },
  },
};

export default spec;
