/**
 * Default command registry for the bash risk classifier.
 *
 * A data-driven registry of 200+ commands with base risk levels, subcommand
 * overrides, and arg-level rules. This is the "smart defaults" layer — users
 * can override any entry via their personal rule store.
 *
 * Every program in checker.ts's LOW_RISK_PROGRAMS, HIGH_RISK_PROGRAMS,
 * WRAPPER_PROGRAMS, and LOW_RISK_GIT_SUBCOMMANDS has a corresponding entry.
 * Divergences from the existing checker classification are documented inline.
 *
 * @see /docs/bash-risk-classifier-design.md Section 6.2
 */

import type { CommandRiskSpec } from "./risk-types.js";

// ── Shared regex pattern constants ────────────────────────────────────────────
// These are used across multiple command entries. Stored as strings (not native
// RegExp) so they round-trip cleanly through JSON serialization.

/** Matches paths containing sensitive directories (.ssh, .gnupg, .aws, .config, .env). */
const SENSITIVE_PATHS = String.raw`(?:^|/)(?:\.ssh|\.gnupg|\.aws|\.config|\.env)\b`;

/** Matches system paths (/usr, /bin, /sbin, /lib, /boot, /dev, /proc, /sys). */
const SYSTEM_PATHS = String.raw`^/(?:usr|bin|sbin|lib|boot|dev|proc|sys)\b`;

/** Matches temp/relative paths (/tmp, /var/tmp, ./, ../). */
const TMP_PATHS = String.raw`^(?:/tmp|/var/tmp|\./|\.\.\/)`;

/** Matches localhost URLs (localhost, 127.0.0.1, ::1). */
const LOCALHOST_URL = String.raw`^https?://(localhost|127\.0\.0\.1|\[::1\])`;

// ── Default command registry ──────────────────────────────────────────────────

export const DEFAULT_COMMAND_REGISTRY = {
  // ── Read-only filesystem commands ──────────────────────────────────────────
  ls: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  cat: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
    argRules: [
      {
        id: "cat:sensitive",
        valuePattern: SENSITIVE_PATHS,
        risk: "high",
        reason: "Reads sensitive file",
      },
    ],
  },
  head: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  tail: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  less: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  more: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  wc: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  file: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  stat: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  du: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  df: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  diff: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  tree: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  pwd: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    argSchema: { positionals: "none" },
  },
  realpath: { baseRisk: "low", sandboxAutoApprove: true, argSchema: {} },
  basename: { baseRisk: "low", sandboxAutoApprove: true, argSchema: {} },
  dirname: { baseRisk: "low", sandboxAutoApprove: true, argSchema: {} },
  readlink: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  dir: { baseRisk: "low", filesystemOp: true, argSchema: {} },
  vdir: { baseRisk: "low", filesystemOp: true, argSchema: {} },
  locate: { baseRisk: "low" },
  plocate: { baseRisk: "low" },
  cmp: { baseRisk: "low", filesystemOp: true, argSchema: {} },
  comm: { baseRisk: "low", filesystemOp: true, argSchema: {} },
  nl: { baseRisk: "low", filesystemOp: true, argSchema: {} },
  od: { baseRisk: "low", filesystemOp: true, argSchema: {} },
  strings: { baseRisk: "low", filesystemOp: true, argSchema: {} },

  // ── Search / filter / text processing ──────────────────────────────────────
  grep: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {
      positionals: [{ role: "pattern" }, { role: "path", rest: true }],
    },
  },
  rg: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    argSchema: {
      positionals: [{ role: "pattern" }, { role: "path", rest: true }],
    },
  },
  ag: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    argSchema: {
      positionals: [{ role: "pattern" }, { role: "path", rest: true }],
    },
  },
  ack: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    argSchema: {
      positionals: [{ role: "pattern" }, { role: "path", rest: true }],
    },
  },
  sort: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {
      valueFlags: ["-o", "--output"],
      pathFlags: { "-o": true, "--output": true },
    },
    argRules: [
      {
        id: "sort:output",
        flags: ["-o", "--output"],
        risk: "medium",
        reason: "Writes sorted output to file",
      },
      {
        id: "sort:output-sensitive",
        flags: ["-o", "--output"],
        valuePattern: SENSITIVE_PATHS,
        risk: "high",
        reason: "Writes sorted output to sensitive path",
      },
    ],
  },
  egrep: {
    baseRisk: "low",
    filesystemOp: true,
    argSchema: {
      positionals: [{ role: "pattern" }, { role: "path", rest: true }],
    },
  },
  fgrep: {
    baseRisk: "low",
    filesystemOp: true,
    argSchema: {
      positionals: [{ role: "pattern" }, { role: "path", rest: true }],
    },
  },
  uniq: { baseRisk: "low", sandboxAutoApprove: true, argSchema: {} },
  cut: { baseRisk: "low", sandboxAutoApprove: true, argSchema: {} },
  paste: { baseRisk: "low", filesystemOp: true, argSchema: {} },
  join: { baseRisk: "low", filesystemOp: true, argSchema: {} },
  column: { baseRisk: "low", filesystemOp: true, argSchema: {} },
  fold: { baseRisk: "low", filesystemOp: true, argSchema: {} },
  fmt: { baseRisk: "low", filesystemOp: true, argSchema: {} },
  pr: { baseRisk: "low", filesystemOp: true, argSchema: {} },
  expand: { baseRisk: "low", filesystemOp: true, argSchema: {} },
  unexpand: { baseRisk: "low", filesystemOp: true, argSchema: {} },
  rev: { baseRisk: "low", argSchema: {} },
  shuf: { baseRisk: "low", argSchema: {} },
  iconv: { baseRisk: "low", argSchema: {} },
  split: { baseRisk: "medium", filesystemOp: true, argSchema: {} },
  csplit: { baseRisk: "medium", filesystemOp: true, argSchema: {} },
  dos2unix: { baseRisk: "medium", filesystemOp: true, argSchema: {} },
  unix2dos: { baseRisk: "medium", filesystemOp: true, argSchema: {} },
  tr: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    argSchema: { positionals: "none" },
  },
  sed: {
    baseRisk: "medium",
    reason: "Can write files or execute commands via sed scripts",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {
      positionals: [{ role: "script" }, { role: "path", rest: true }],
    },
    argRules: [
      {
        id: "sed:inplace",
        flags: ["-i", "--in-place"],
        risk: "medium",
        reason: "Edits files in place",
      },
    ],
  },
  awk: {
    baseRisk: "medium",
    argSchema: {
      positionals: [{ role: "script" }, { role: "path", rest: true }],
    },
    complexSyntax: true,
    reason: "Can execute shell commands via system()",
  },

  // ── System information (read-only) ─────────────────────────────────────────
  echo: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    argSchema: { positionals: "none" },
  },
  printf: {
    baseRisk: "low",
    sandboxAutoApprove: true,
    argSchema: { positionals: "none" },
  },
  whoami: { baseRisk: "low" },
  uname: { baseRisk: "low" },
  uptime: { baseRisk: "low" },
  hostname: { baseRisk: "low" },
  date: { baseRisk: "low" },
  cal: { baseRisk: "low" },
  id: { baseRisk: "low" },
  ps: { baseRisk: "low" },
  pgrep: { baseRisk: "low" },
  pstree: { baseRisk: "low" },
  top: { baseRisk: "low" },
  htop: { baseRisk: "low" },
  lsof: { baseRisk: "low" },
  free: { baseRisk: "low" },
  vmstat: { baseRisk: "low" },
  iostat: { baseRisk: "low" },
  which: { baseRisk: "low" },
  where: { baseRisk: "low" },
  whereis: { baseRisk: "low" },
  type: { baseRisk: "low" },
  groups: { baseRisk: "low" },
  users: { baseRisk: "low" },
  who: { baseRisk: "low" },
  w: { baseRisk: "low" },
  last: { baseRisk: "low" },
  printenv: { baseRisk: "low" },
  man: { baseRisk: "low" },
  help: { baseRisk: "low" },
  info: { baseRisk: "low" },
  sw_vers: { baseRisk: "low" },
  dmesg: {
    baseRisk: "medium",
    argRules: [
      {
        id: "dmesg:clear",
        flags: ["-C", "--clear", "-c"],
        risk: "high",
        reason: "Clears kernel ring buffer",
      },
    ],
  },
  sysctl: {
    baseRisk: "medium",
    argSchema: {
      valueFlags: ["-w", "--write", "-p", "--load"],
    },
    argRules: [
      {
        id: "sysctl:write",
        flags: ["-w", "--write"],
        risk: "high",
        reason: "Writes kernel parameters",
      },
      {
        id: "sysctl:load",
        flags: ["-p", "--load", "--system"],
        risk: "high",
        reason: "Loads kernel parameter settings",
      },
    ],
  },

  // ── Checksum / hex tools ───────────────────────────────────────────────────
  sha1sum: { baseRisk: "low", filesystemOp: true },
  sha256sum: { baseRisk: "low", filesystemOp: true },
  sha512sum: { baseRisk: "low", filesystemOp: true },
  b2sum: { baseRisk: "low", filesystemOp: true },
  cksum: { baseRisk: "low", filesystemOp: true },
  md5sum: { baseRisk: "low", filesystemOp: true },
  md5: { baseRisk: "low", filesystemOp: true },
  base64: { baseRisk: "low", argSchema: {} },
  xxd: { baseRisk: "low" },
  hexdump: { baseRisk: "low" },

  // ── Data processing ────────────────────────────────────────────────────────
  jq: { baseRisk: "low", sandboxAutoApprove: true, argSchema: {} },
  yq: { baseRisk: "low", sandboxAutoApprove: true, argSchema: {} },

  // ── Find ───────────────────────────────────────────────────────────────────
  // DIVERGENCE: checker.ts lists `find` as LOW_RISK unconditionally. Our
  // registry adds arg rules for -exec/-execdir/-delete which escalate to high.
  find: {
    baseRisk: "low",
    filesystemOp: true,
    argSchema: {
      valueFlags: [
        "-name",
        "-iname",
        "-path",
        "-ipath",
        "-regex",
        "-iregex",
        "-maxdepth",
        "-mindepth",
        "-newer",
        "-user",
        "-group",
        "-printf",
        "-fprintf",
      ],
    },
    complexSyntax: true,
    argRules: [
      {
        id: "find:exec",
        flags: ["-exec", "-execdir"],
        risk: "high",
        reason: "Executes arbitrary commands on matched files",
      },
      {
        id: "find:delete",
        flags: ["-delete"],
        risk: "high",
        reason: "Deletes matched files",
      },
    ],
  },
  fd: { baseRisk: "low", sandboxAutoApprove: true, argSchema: {} },

  // ── Write commands ─────────────────────────────────────────────────────────
  cp: {
    baseRisk: "medium",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {
      valueFlags: ["-t", "--target-directory"],
      pathFlags: { "-t": true, "--target-directory": true },
    },
    argRules: [
      {
        id: "cp:system",
        valuePattern: SYSTEM_PATHS,
        risk: "high",
        reason: "Copies to system path",
      },
    ],
  },
  mv: {
    baseRisk: "medium",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
    argRules: [
      {
        id: "mv:system",
        valuePattern: SYSTEM_PATHS,
        risk: "high",
        reason: "Moves to system path",
      },
    ],
  },
  mkdir: {
    baseRisk: "medium",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  touch: {
    baseRisk: "medium",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  ln: {
    baseRisk: "medium",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {
      valueFlags: ["-t", "--target-directory"],
      pathFlags: { "-t": true, "--target-directory": true },
    },
  },
  install: {
    baseRisk: "medium",
    filesystemOp: true,
    argSchema: {
      valueFlags: ["-t", "--target-directory"],
      pathFlags: { "-t": true, "--target-directory": true },
    },
    argRules: [
      {
        id: "install:system",
        valuePattern: SYSTEM_PATHS,
        risk: "high",
        reason: "Installs files into system path",
      },
    ],
  },
  truncate: { baseRisk: "medium", filesystemOp: true, argSchema: {} },
  mktemp: { baseRisk: "medium", filesystemOp: true, argSchema: {} },
  // DIVERGENCE: checker.ts lists `tee` as LOW_RISK. Our registry classifies
  // it as medium because it writes to files.
  tee: {
    baseRisk: "medium",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },

  // ── Delete commands ────────────────────────────────────────────────────────
  rm: {
    baseRisk: "high",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
    argRules: [
      {
        id: "rm:recursive-force",
        flags: ["-rf", "-fr", "-Rf", "-fR"],
        risk: "high",
        reason: "Recursive force delete",
      },
      {
        id: "rm:recursive",
        flags: ["-r", "-R", "--recursive"],
        risk: "high",
        reason: "Recursive delete",
      },
      {
        id: "rm:tmp",
        valuePattern: TMP_PATHS,
        risk: "medium",
        reason: "Removes temp files",
      },
      {
        id: "rm:system",
        valuePattern: SYSTEM_PATHS,
        risk: "high",
        reason: "Removes system files",
      },
      {
        id: "rm:sensitive",
        valuePattern: SENSITIVE_PATHS,
        risk: "high",
        reason: "Removes sensitive files",
      },
    ],
  },
  rmdir: {
    baseRisk: "high",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  unlink: { baseRisk: "high", filesystemOp: true, argSchema: {} },
  shred: { baseRisk: "high", filesystemOp: true, argSchema: {} },

  // ── Network commands ───────────────────────────────────────────────────────
  curl: {
    baseRisk: "medium",
    argSchema: {
      valueFlags: [
        "-d",
        "--data",
        "--data-binary",
        "--data-raw",
        "--data-urlencode",
        "-T",
        "--upload-file",
        "-o",
        "--output",
        "-H",
        "--header",
        "-X",
        "--request",
        "-u",
        "--user",
        "-A",
        "--user-agent",
        "-e",
        "--referer",
        "-b",
        "--cookie",
        "-c",
        "--cookie-jar",
        "--connect-timeout",
        "-m",
        "--max-time",
        "--retry",
        "-w",
        "--write-out",
      ],
      positionals: "none", // positionals are URLs, not paths
    },
    argRules: [
      {
        id: "curl:upload-data",
        flags: ["-d", "--data", "--data-binary", "--data-raw"],
        valuePattern: String.raw`^@`,
        risk: "high",
        reason: "Uploads file contents",
      },
      {
        id: "curl:upload-file",
        flags: ["-T", "--upload-file"],
        risk: "high",
        reason: "Uploads file",
      },
      {
        id: "curl:output-sensitive",
        flags: ["-o", "--output"],
        valuePattern: SENSITIVE_PATHS,
        risk: "high",
        reason: "Writes to sensitive path",
      },
      {
        id: "curl:localhost",
        valuePattern: LOCALHOST_URL,
        risk: "low",
        reason: "Local request",
      },
    ],
  },
  wget: {
    baseRisk: "medium",
    argSchema: {
      valueFlags: [
        "-O",
        "--output-document",
        "-o",
        "--output-file",
        "--post-file",
        "--method",
        "--body-data",
        "--header",
      ],
      positionals: "none",
    },
    argRules: [
      {
        id: "wget:post-file",
        flags: ["--post-file"],
        risk: "high",
        reason: "Uploads file contents",
      },
      {
        id: "wget:output-sensitive",
        flags: ["-O", "--output-document"],
        valuePattern: SENSITIVE_PATHS,
        risk: "high",
        reason: "Writes response to sensitive path",
      },
      {
        id: "wget:localhost",
        valuePattern: LOCALHOST_URL,
        risk: "low",
        reason: "Local request",
      },
    ],
  },
  // DIVERGENCE: checker.ts lists `http` (httpie) as LOW_RISK. Our registry
  // classifies it as medium because it can make network requests with side effects.
  http: { baseRisk: "medium" },
  ping: { baseRisk: "low" },
  dig: { baseRisk: "low" },
  nslookup: { baseRisk: "low" },
  host: { baseRisk: "low" },
  traceroute: { baseRisk: "low" },
  tracepath: { baseRisk: "low" },
  mtr: { baseRisk: "low" },
  netstat: { baseRisk: "low" },
  ss: { baseRisk: "low" },
  nc: { baseRisk: "medium", reason: "Opens arbitrary network connections" },
  netcat: { baseRisk: "medium", reason: "Opens arbitrary network connections" },
  telnet: { baseRisk: "medium", reason: "Opens remote terminal connection" },
  ftp: { baseRisk: "medium", reason: "Transfers files over network" },
  ssh: { baseRisk: "high", reason: "Opens remote shell" },
  scp: { baseRisk: "high", reason: "Remote file transfer" },
  sftp: { baseRisk: "high", reason: "Remote file transfer" },
  rsync: { baseRisk: "high", reason: "Remote file sync" },
  "ssh-keygen": {
    baseRisk: "medium",
    filesystemOp: true,
    argSchema: {},
    reason: "Generates and can overwrite SSH keys",
  },
  "ssh-add": {
    baseRisk: "high",
    reason: "Adds private keys to authentication agent",
  },
  "ssh-copy-id": {
    baseRisk: "high",
    reason: "Modifies remote authorized_keys",
  },
  nmap: { baseRisk: "medium", reason: "Performs active network scanning" },
  ifconfig: {
    baseRisk: "medium",
    reason: "Can reconfigure network interfaces",
  },
  ip: { baseRisk: "high", reason: "Can reconfigure networking and routing" },
  route: { baseRisk: "high", reason: "Modifies network routing" },
  nmcli: { baseRisk: "high", reason: "Controls NetworkManager settings" },
  openssl: { baseRisk: "medium", reason: "Performs cryptographic operations" },

  // ── Git ────────────────────────────────────────────────────────────────────
  // Every subcommand in checker.ts's LOW_RISK_GIT_SUBCOMMANDS must appear here.
  // Divergences are noted inline.
  git: {
    baseRisk: "medium",
    argSchema: {
      valueFlags: [
        "-C",
        "-c",
        "--git-dir",
        "--work-tree",
        "--namespace",
        "--super-prefix",
        "--config-env",
      ],
    },
    subcommands: {
      // LOW_RISK_GIT_SUBCOMMANDS from checker.ts:
      status: { baseRisk: "low" },
      log: { baseRisk: "low" },
      diff: { baseRisk: "low" },
      show: { baseRisk: "low" },
      branch: {
        baseRisk: "low",
        argRules: [
          {
            id: "git-branch:delete",
            flags: ["-d", "-D", "--delete"],
            risk: "medium",
            reason: "Deletes local branch",
          },
          {
            id: "git-branch:move",
            flags: ["-m", "-M", "--move"],
            risk: "medium",
            reason: "Renames local branch",
          },
          {
            id: "git-branch:copy",
            flags: ["-c", "-C", "--copy"],
            risk: "medium",
            reason: "Copies local branch",
          },
        ],
      },
      tag: {
        baseRisk: "low",
        argRules: [
          {
            id: "git-tag:delete",
            flags: ["-d", "--delete"],
            risk: "high",
            reason: "Deletes git tag",
          },
        ],
      },
      remote: {
        baseRisk: "low",
        subcommands: {
          show: { baseRisk: "low" },
          "get-url": { baseRisk: "low" },
          add: { baseRisk: "medium", reason: "Adds git remote" },
          "set-url": { baseRisk: "medium", reason: "Changes remote URL" },
          rename: { baseRisk: "medium", reason: "Renames git remote" },
          remove: { baseRisk: "medium", reason: "Removes git remote" },
          prune: { baseRisk: "medium", reason: "Prunes stale remote refs" },
        },
      },
      // DIVERGENCE: checker.ts lists `stash` as LOW_RISK. Our registry classifies
      // the base stash command as medium (it modifies working tree), with read-only
      // subcommands (list, show) as low and destructive ones (drop) as high.
      stash: {
        baseRisk: "medium",
        subcommands: {
          list: { baseRisk: "low" },
          show: { baseRisk: "low" },
          drop: {
            baseRisk: "high",
            reason: "Permanently drops stashed changes",
          },
        },
      },
      blame: { baseRisk: "low" },
      shortlog: { baseRisk: "low" },
      describe: { baseRisk: "low" },
      "rev-parse": { baseRisk: "low" },
      "ls-files": { baseRisk: "low" },
      "ls-tree": { baseRisk: "low" },
      "cat-file": { baseRisk: "low" },
      reflog: { baseRisk: "low" },
      // Write operations:
      init: { baseRisk: "medium" },
      clone: { baseRisk: "medium" },
      add: { baseRisk: "medium" },
      commit: { baseRisk: "medium" },
      config: {
        baseRisk: "medium",
        argRules: [
          {
            id: "git-config:global",
            flags: ["--global"],
            risk: "high",
            reason: "Modifies global git configuration",
          },
          {
            id: "git-config:system",
            flags: ["--system"],
            risk: "high",
            reason: "Modifies system git configuration",
          },
        ],
      },
      checkout: { baseRisk: "medium" },
      restore: { baseRisk: "medium" },
      switch: { baseRisk: "medium" },
      merge: { baseRisk: "medium" },
      "cherry-pick": { baseRisk: "medium" },
      revert: { baseRisk: "medium" },
      rm: { baseRisk: "medium" },
      mv: { baseRisk: "medium" },
      rebase: {
        baseRisk: "medium",
        argRules: [
          {
            id: "git-rebase:interactive",
            flags: ["-i", "--interactive"],
            risk: "high",
            reason: "Interactive rebase rewrites history",
          },
        ],
      },
      push: {
        baseRisk: "medium",
        argRules: [
          {
            id: "git-push:force",
            flags: ["--force", "-f", "--force-with-lease"],
            risk: "high",
            reason: "Force push rewrites remote history",
          },
        ],
      },
      pull: { baseRisk: "medium" },
      fetch: {
        baseRisk: "low",
        argRules: [
          {
            id: "git-fetch:prune",
            flags: ["-p", "--prune"],
            risk: "medium",
            reason: "Prunes stale remote-tracking refs",
          },
        ],
      },
      reset: {
        baseRisk: "medium",
        argRules: [
          {
            id: "git-reset:hard",
            flags: ["--hard"],
            risk: "high",
            reason: "Discards uncommitted changes",
          },
        ],
      },
      clean: { baseRisk: "high", reason: "Removes untracked files" },
      bisect: { baseRisk: "low" },
      worktree: { baseRisk: "medium" },
      submodule: { baseRisk: "medium" },
    },
  },

  // ── Package managers ───────────────────────────────────────────────────────
  // DIVERGENCE: checker.ts lists `npm`, `npx`, `yarn`, `pnpm`, `bun`, `pip`,
  // `pip3` as LOW_RISK. Our registry classifies them as medium (base) because
  // they download and execute code, with subcommand-level overrides.
  npm: {
    baseRisk: "medium",
    argSchema: {
      valueFlags: ["--prefix", "--userconfig", "--globalconfig", "--cache"],
    },
    subcommands: {
      ls: { baseRisk: "low" },
      list: { baseRisk: "low" },
      outdated: { baseRisk: "low" },
      view: { baseRisk: "low" },
      info: { baseRisk: "low" },
      install: {
        baseRisk: "medium",
        reason: "Runs lifecycle scripts, downloads code",
      },
      ci: {
        baseRisk: "medium",
        reason: "Clean install, runs lifecycle scripts",
      },
      uninstall: { baseRisk: "medium" },
      test: { baseRisk: "high", reason: "Executes arbitrary package scripts" },
      run: { baseRisk: "high", reason: "Executes arbitrary package scripts" },
      exec: { baseRisk: "high", reason: "Executes package binaries" },
      publish: { baseRisk: "high", reason: "Publishes package to registry" },
    },
  },
  // DIVERGENCE: checker.ts lists `npx` as LOW_RISK. Our registry classifies it
  // as high because it downloads and executes arbitrary packages.
  npx: {
    baseRisk: "high",
    reason: "Downloads and executes arbitrary packages",
  },
  bunx: {
    baseRisk: "high",
    reason: "Downloads and executes arbitrary packages",
  },
  pnpx: {
    baseRisk: "high",
    reason: "Downloads and executes arbitrary packages",
  },
  yarn: {
    baseRisk: "medium",
    subcommands: {
      list: { baseRisk: "low" },
      info: { baseRisk: "low" },
      why: { baseRisk: "low" },
      install: { baseRisk: "medium" },
      add: { baseRisk: "medium" },
      remove: { baseRisk: "medium" },
      test: { baseRisk: "high", reason: "Executes arbitrary package scripts" },
      run: { baseRisk: "high", reason: "Executes arbitrary package scripts" },
      dlx: { baseRisk: "high", reason: "Downloads and executes package" },
    },
  },
  pnpm: {
    baseRisk: "medium",
    subcommands: {
      list: { baseRisk: "low" },
      install: { baseRisk: "medium" },
      add: { baseRisk: "medium" },
      remove: { baseRisk: "medium" },
      test: { baseRisk: "high", reason: "Executes arbitrary package scripts" },
      run: { baseRisk: "high", reason: "Executes arbitrary package scripts" },
      exec: { baseRisk: "high", reason: "Executes package binaries" },
      dlx: { baseRisk: "high", reason: "Downloads and executes package" },
    },
  },
  // DIVERGENCE: checker.ts lists `bun` as LOW_RISK. Our registry classifies it
  // as medium (base) with subcommand overrides because it can execute code.
  bun: {
    baseRisk: "medium",
    subcommands: {
      install: { baseRisk: "medium" },
      add: { baseRisk: "medium" },
      update: { baseRisk: "medium" },
      test: { baseRisk: "high", reason: "Executes arbitrary test code" },
      run: { baseRisk: "high", reason: "Executes arbitrary scripts" },
    },
  },
  pip: {
    baseRisk: "medium",
    subcommands: {
      list: { baseRisk: "low" },
      show: { baseRisk: "low" },
      freeze: { baseRisk: "low" },
      install: { baseRisk: "medium" },
      uninstall: { baseRisk: "medium" },
    },
  },
  pip3: {
    baseRisk: "medium",
    subcommands: {
      list: { baseRisk: "low" },
      show: { baseRisk: "low" },
      freeze: { baseRisk: "low" },
      install: { baseRisk: "medium" },
      uninstall: { baseRisk: "medium" },
    },
  },
  brew: {
    baseRisk: "medium",
    subcommands: {
      list: { baseRisk: "low" },
      info: { baseRisk: "low" },
      search: { baseRisk: "low" },
      install: { baseRisk: "medium" },
      update: { baseRisk: "medium" },
      upgrade: { baseRisk: "medium" },
      uninstall: { baseRisk: "high" },
    },
  },
  cargo: {
    baseRisk: "medium",
    subcommands: {
      build: { baseRisk: "medium" },
      check: { baseRisk: "medium" },
      test: { baseRisk: "high", reason: "Executes arbitrary test code" },
      run: { baseRisk: "high", reason: "Compiles and executes code" },
      install: { baseRisk: "medium" },
      uninstall: { baseRisk: "medium" },
    },
  },
  uv: {
    baseRisk: "medium",
    subcommands: {
      sync: { baseRisk: "medium" },
      add: { baseRisk: "medium" },
      remove: { baseRisk: "medium" },
      run: { baseRisk: "high", reason: "Executes arbitrary commands" },
      tool: {
        baseRisk: "medium",
        subcommands: {
          run: { baseRisk: "high", reason: "Executes installed tool" },
        },
      },
    },
  },
  pipx: {
    baseRisk: "medium",
    subcommands: {
      list: { baseRisk: "low" },
      install: { baseRisk: "medium" },
      uninstall: { baseRisk: "medium" },
      run: { baseRisk: "high", reason: "Executes package entrypoint" },
    },
  },
  poetry: {
    baseRisk: "medium",
    subcommands: {
      show: { baseRisk: "low" },
      install: { baseRisk: "medium" },
      add: { baseRisk: "medium" },
      remove: { baseRisk: "medium" },
      run: { baseRisk: "high", reason: "Executes arbitrary commands" },
    },
  },
  gem: {
    baseRisk: "medium",
    subcommands: {
      list: { baseRisk: "low" },
      search: { baseRisk: "low" },
      install: { baseRisk: "medium" },
      uninstall: { baseRisk: "medium" },
    },
  },
  composer: {
    baseRisk: "medium",
    subcommands: {
      show: { baseRisk: "low" },
      install: { baseRisk: "medium" },
      update: { baseRisk: "medium" },
      remove: { baseRisk: "medium" },
      "run-script": { baseRisk: "high", reason: "Executes arbitrary scripts" },
    },
  },

  // ── Build tools (inherently opaque) ────────────────────────────────────────
  make: { baseRisk: "high", reason: "Executes arbitrary Makefile targets" },
  cmake: {
    baseRisk: "high",
    reason: "Evaluates CMake scripts and can execute commands",
  },
  ninja: { baseRisk: "high", reason: "Executes build graph commands" },
  meson: {
    baseRisk: "high",
    reason: "Configures builds and can execute project-defined commands",
  },
  mvn: { baseRisk: "high", reason: "Executes Maven plugins and build scripts" },
  gradle: {
    baseRisk: "high",
    reason: "Executes Gradle build scripts and plugins",
  },
  ant: { baseRisk: "high", reason: "Executes Ant targets and tasks" },
  bazel: { baseRisk: "high", reason: "Executes project-defined build actions" },

  // ── Language runtimes ──────────────────────────────────────────────────────
  // DIVERGENCE: checker.ts lists `node` as LOW_RISK. Our registry classifies it
  // as high because it executes arbitrary JavaScript.
  node: {
    baseRisk: "high",
    reason: "Executes arbitrary JavaScript",
    argRules: [
      {
        id: "node:version",
        flags: ["--version", "-v"],
        risk: "low",
        reason: "Prints version",
      },
      {
        id: "node:eval",
        flags: ["-e", "--eval"],
        risk: "high",
        reason: "Evaluates inline JavaScript",
      },
    ],
  },
  // DIVERGENCE: checker.ts lists `deno` as LOW_RISK. Our registry classifies it
  // as high because it executes arbitrary code.
  deno: { baseRisk: "high", reason: "Executes arbitrary code" },
  // DIVERGENCE: checker.ts lists `python` and `python3` as LOW_RISK. Our registry
  // classifies them as high because they execute arbitrary Python code.
  python: {
    baseRisk: "high",
    reason: "Executes arbitrary Python code",
    argRules: [
      {
        id: "python:version",
        flags: ["--version", "-V"],
        risk: "low",
        reason: "Prints version",
      },
    ],
  },
  python3: {
    baseRisk: "high",
    reason: "Executes arbitrary Python code",
    argRules: [
      {
        id: "python3:version",
        flags: ["--version", "-V"],
        risk: "low",
        reason: "Prints version",
      },
    ],
  },
  ruby: { baseRisk: "high", reason: "Executes arbitrary Ruby code" },
  perl: {
    baseRisk: "high",
    reason: "Executes arbitrary Perl code",
    argRules: [
      {
        id: "perl:version",
        flags: ["--version", "-v"],
        risk: "low",
        reason: "Prints version",
      },
    ],
  },
  php: {
    baseRisk: "high",
    reason: "Executes arbitrary PHP code",
    argRules: [
      {
        id: "php:version",
        flags: ["--version", "-v"],
        risk: "low",
        reason: "Prints version",
      },
    ],
  },
  lua: {
    baseRisk: "high",
    reason: "Executes arbitrary Lua code",
    argRules: [
      {
        id: "lua:version",
        flags: ["-v", "--version"],
        risk: "low",
        reason: "Prints version",
      },
    ],
  },
  java: {
    baseRisk: "high",
    reason: "Executes Java bytecode",
    argRules: [
      {
        id: "java:version",
        flags: ["-version", "--version"],
        risk: "low",
        reason: "Prints version",
      },
    ],
  },
  javac: {
    baseRisk: "high",
    reason: "Compilation can run annotation processors",
  },
  R: { baseRisk: "high", reason: "Executes arbitrary R code" },
  Rscript: { baseRisk: "high", reason: "Executes arbitrary R code" },
  "ts-node": { baseRisk: "high", reason: "Executes TypeScript code" },
  tsx: { baseRisk: "high", reason: "Executes TypeScript/JavaScript code" },
  pwsh: { baseRisk: "high", reason: "Executes arbitrary PowerShell code" },
  powershell: {
    baseRisk: "high",
    reason: "Executes arbitrary PowerShell code",
  },
  swift: {
    baseRisk: "low",
    subcommands: {
      package: { baseRisk: "low" },
      build: { baseRisk: "medium" },
      test: { baseRisk: "high", reason: "Executes arbitrary test code" },
      run: { baseRisk: "high", reason: "Compiles and executes Swift code" },
    },
  },
  go: {
    // baseRisk is low (unlike npm's medium) because bare `go` prints help.
    // Dangerous subcommands (run, test, generate, get) are handled individually.
    baseRisk: "low",
    subcommands: {
      mod: { baseRisk: "low" },
      vet: { baseRisk: "low" },
      version: { baseRisk: "low" },
      build: { baseRisk: "medium" },
      test: { baseRisk: "high", reason: "Executes arbitrary test code" },
      run: { baseRisk: "high", reason: "Compiles and executes Go code" },
      get: {
        baseRisk: "medium",
        reason:
          "Downloads and installs packages; may execute arbitrary code via tool directives",
      },
      generate: {
        baseRisk: "high",
        reason: "Runs arbitrary commands via //go:generate directives",
      },
    },
  },

  // ── Docker ─────────────────────────────────────────────────────────────────
  docker: {
    baseRisk: "medium",
    argSchema: {
      valueFlags: ["--host", "-H", "--config", "--context", "--log-level"],
    },
    subcommands: {
      ps: { baseRisk: "low" },
      images: { baseRisk: "low" },
      inspect: { baseRisk: "low" },
      logs: { baseRisk: "low" },
      info: { baseRisk: "low" },
      version: { baseRisk: "low" },
      login: { baseRisk: "medium" },
      logout: { baseRisk: "medium" },
      build: { baseRisk: "medium" },
      pull: { baseRisk: "medium" },
      push: { baseRisk: "high", reason: "Pushes image to registry" },
      cp: { baseRisk: "medium" },
      restart: { baseRisk: "medium" },
      kill: { baseRisk: "high", reason: "Forcefully stops container" },
      prune: { baseRisk: "high", reason: "Deletes unused docker resources" },
      system: {
        baseRisk: "medium",
        subcommands: {
          df: { baseRisk: "low" },
          prune: {
            baseRisk: "high",
            reason: "Deletes unused docker resources",
          },
        },
      },
      network: {
        baseRisk: "medium",
        subcommands: {
          ls: { baseRisk: "low" },
          inspect: { baseRisk: "low" },
          create: { baseRisk: "medium" },
          rm: { baseRisk: "medium" },
          prune: { baseRisk: "high", reason: "Deletes docker networks" },
        },
      },
      volume: {
        baseRisk: "medium",
        subcommands: {
          ls: { baseRisk: "low" },
          inspect: { baseRisk: "low" },
          create: { baseRisk: "medium" },
          rm: { baseRisk: "medium" },
          prune: { baseRisk: "high", reason: "Deletes docker volumes" },
        },
      },
      compose: {
        baseRisk: "medium",
        subcommands: {
          ps: { baseRisk: "low" },
          logs: { baseRisk: "low" },
          config: { baseRisk: "low" },
          pull: { baseRisk: "medium" },
          build: { baseRisk: "medium" },
          up: { baseRisk: "medium" },
          down: { baseRisk: "medium" },
          start: { baseRisk: "medium" },
          stop: { baseRisk: "medium" },
          restart: { baseRisk: "medium" },
          rm: { baseRisk: "medium" },
          run: { baseRisk: "high", reason: "Runs one-off container command" },
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
            valuePattern: String.raw`^/:`,
            risk: "high",
            reason: "Mounts host root filesystem",
          },
        ],
      },
      exec: {
        baseRisk: "high",
        reason: "Executes command in running container",
      },
      rm: { baseRisk: "high" },
      rmi: { baseRisk: "high" },
      stop: { baseRisk: "medium" },
      start: { baseRisk: "medium" },
    },
  },

  // ── Infrastructure / orchestration CLIs ────────────────────────────────────
  kubectl: {
    baseRisk: "medium",
    subcommands: {
      get: { baseRisk: "low" },
      describe: { baseRisk: "low" },
      logs: { baseRisk: "low" },
      top: { baseRisk: "low" },
      version: { baseRisk: "low" },
      "cluster-info": { baseRisk: "low" },
      config: { baseRisk: "medium" },
      apply: {
        baseRisk: "high",
        reason: "Applies changes to cluster resources",
      },
      patch: { baseRisk: "high", reason: "Mutates cluster resources" },
      edit: { baseRisk: "high", reason: "Mutates cluster resources" },
      delete: { baseRisk: "high", reason: "Deletes cluster resources" },
      replace: { baseRisk: "high", reason: "Replaces cluster resources" },
      scale: { baseRisk: "high", reason: "Scales workloads in cluster" },
      exec: {
        baseRisk: "high",
        reason: "Executes commands in running cluster workloads",
      },
      cp: { baseRisk: "high", reason: "Copies files to/from workloads" },
      "port-forward": {
        baseRisk: "medium",
        reason: "Opens local network tunnel",
      },
    },
  },
  helm: {
    baseRisk: "medium",
    subcommands: {
      list: { baseRisk: "low" },
      search: { baseRisk: "low" },
      status: { baseRisk: "low" },
      get: { baseRisk: "low" },
      template: { baseRisk: "low" },
      install: { baseRisk: "high", reason: "Installs workloads to cluster" },
      upgrade: { baseRisk: "high", reason: "Upgrades workloads in cluster" },
      rollback: { baseRisk: "high", reason: "Rolls back workloads in cluster" },
      uninstall: { baseRisk: "high", reason: "Removes workloads from cluster" },
    },
  },
  terraform: {
    baseRisk: "medium",
    subcommands: {
      fmt: { baseRisk: "low" },
      validate: { baseRisk: "low" },
      plan: { baseRisk: "medium" },
      apply: {
        baseRisk: "high",
        reason: "Applies infrastructure changes",
      },
      destroy: {
        baseRisk: "high",
        reason: "Destroys managed infrastructure",
      },
      import: { baseRisk: "high", reason: "Mutates Terraform state" },
      state: { baseRisk: "medium", reason: "Reads or mutates Terraform state" },
    },
  },
  aws: { baseRisk: "high", reason: "Can mutate cloud infrastructure" },
  gcloud: { baseRisk: "high", reason: "Can mutate cloud infrastructure" },
  az: { baseRisk: "high", reason: "Can mutate cloud infrastructure" },

  // ── Privilege / system ─────────────────────────────────────────────────────
  sudo: {
    baseRisk: "high",
    isWrapper: true,
    reason: "Elevates to superuser privileges",
  },
  su: { baseRisk: "high", reason: "Switches user identity" },
  doas: {
    baseRisk: "high",
    isWrapper: true,
    reason: "Elevates privileges (OpenBSD sudo alternative)",
  },
  chmod: {
    baseRisk: "high",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
    reason: "Changes file permissions",
  },
  chown: {
    baseRisk: "high",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
    reason: "Changes file ownership",
  },
  chgrp: {
    baseRisk: "high",
    sandboxAutoApprove: true,
    argSchema: {},
    reason: "Changes file group",
  },
  mount: { baseRisk: "high", reason: "Mounts filesystem" },
  umount: { baseRisk: "high", reason: "Unmounts filesystem" },
  chroot: { baseRisk: "high", reason: "Changes root directory for command" },
  systemctl: { baseRisk: "high", reason: "Controls system services" },
  service: { baseRisk: "high", reason: "Controls system services" },
  launchctl: { baseRisk: "high", reason: "Controls macOS services" },
  loginctl: { baseRisk: "high", reason: "Controls system logind sessions" },
  passwd: { baseRisk: "high", reason: "Changes account credentials" },
  visudo: { baseRisk: "high", reason: "Edits sudo policy" },
  crontab: {
    baseRisk: "high",
    reason: "Schedules privileged command execution",
  },
  at: { baseRisk: "high", reason: "Schedules command execution" },
  networksetup: { baseRisk: "high", reason: "Modifies macOS network settings" },
  defaults: { baseRisk: "medium", reason: "Modifies macOS preference domains" },

  // ── User management ────────────────────────────────────────────────────────
  useradd: { baseRisk: "high", reason: "Creates system user" },
  adduser: { baseRisk: "high", reason: "Creates system user" },
  userdel: { baseRisk: "high", reason: "Deletes system user" },
  deluser: { baseRisk: "high", reason: "Deletes system user" },
  usermod: { baseRisk: "high", reason: "Modifies system user" },
  groupadd: { baseRisk: "high", reason: "Creates system group" },
  groupdel: { baseRisk: "high", reason: "Deletes system group" },
  groupmod: { baseRisk: "high", reason: "Modifies system group" },

  // ── Firewall ───────────────────────────────────────────────────────────────
  iptables: { baseRisk: "high", reason: "Modifies firewall rules" },
  ip6tables: { baseRisk: "high", reason: "Modifies IPv6 firewall rules" },
  nft: { baseRisk: "high", reason: "Modifies firewall rules" },
  ufw: { baseRisk: "high", reason: "Modifies firewall rules" },
  "firewall-cmd": { baseRisk: "high", reason: "Modifies firewall rules" },

  // ── System lifecycle ───────────────────────────────────────────────────────
  reboot: { baseRisk: "high", reason: "Reboots the system" },
  shutdown: { baseRisk: "high", reason: "Shuts down the system" },
  halt: { baseRisk: "high", reason: "Halts the system" },
  poweroff: { baseRisk: "high", reason: "Powers off the system" },

  // ── Process management ─────────────────────────────────────────────────────
  kill: { baseRisk: "high", reason: "Sends signal to process" },
  killall: { baseRisk: "high", reason: "Kills processes by name" },
  pkill: { baseRisk: "high", reason: "Kills processes by pattern" },
  renice: { baseRisk: "medium", reason: "Changes process scheduling priority" },

  // ── Catastrophic ───────────────────────────────────────────────────────────
  mkfs: { baseRisk: "high", reason: "Formats filesystem — destroys all data" },
  dd: {
    baseRisk: "high",
    reason: "Low-level block device copy — can destroy disks",
  },
  fdisk: { baseRisk: "high", reason: "Modifies disk partitions" },
  parted: { baseRisk: "high", reason: "Modifies disk partitions" },
  wipefs: {
    baseRisk: "high",
    reason: "Erases filesystem and partition signatures",
  },

  // ── Wrapper commands ───────────────────────────────────────────────────────
  // These unwrap to find and classify the inner command. The classifier takes
  // max(wrapper.baseRisk, inner.risk).
  env: { baseRisk: "low", isWrapper: true },
  nice: { baseRisk: "low", isWrapper: true },
  nohup: { baseRisk: "low", isWrapper: true },
  timeout: {
    baseRisk: "low",
    isWrapper: true,
    nonExecFlags: ["--help", "--version"],
  },
  time: { baseRisk: "low", isWrapper: true },
  command: {
    baseRisk: "low",
    isWrapper: true,
    nonExecFlags: ["-v", "-V"],
    argRules: [
      {
        id: "command:lookup",
        flags: ["-v", "-V"],
        risk: "low",
        reason: "Command lookup",
      },
    ],
  },
  exec: {
    baseRisk: "high",
    isWrapper: true,
    reason: "Replaces current shell process",
  },
  strace: {
    baseRisk: "medium",
    isWrapper: true,
    reason: "Traces system calls",
  },
  ltrace: {
    baseRisk: "medium",
    isWrapper: true,
    reason: "Traces library calls",
  },
  ionice: { baseRisk: "low", isWrapper: true },
  taskset: { baseRisk: "low", isWrapper: true },

  // ── Shell interpreters ──────────────────────────────────────────────────────
  // These execute arbitrary code via -c, script files, or stdin.
  bash: {
    baseRisk: "high",
    reason: "Executes arbitrary shell commands",
    complexSyntax: true,
  },
  sh: {
    baseRisk: "high",
    reason: "Executes arbitrary shell commands",
    complexSyntax: true,
  },
  zsh: {
    baseRisk: "high",
    reason: "Executes arbitrary shell commands",
    complexSyntax: true,
  },
  dash: {
    baseRisk: "high",
    reason: "Executes arbitrary shell commands",
    complexSyntax: true,
  },
  fish: {
    baseRisk: "high",
    reason: "Executes arbitrary shell commands",
    complexSyntax: true,
  },
  ksh: {
    baseRisk: "high",
    reason: "Executes arbitrary shell commands",
    complexSyntax: true,
  },
  tcsh: {
    baseRisk: "high",
    reason: "Executes arbitrary shell commands",
    complexSyntax: true,
  },

  // ── Package managers (additional) ──────────────────────────────────────────
  "apt-get": { baseRisk: "high", reason: "Installs/removes system packages" },
  apt: { baseRisk: "high", reason: "Installs/removes system packages" },
  dnf: { baseRisk: "high", reason: "Installs/removes system packages" },
  yum: { baseRisk: "high", reason: "Installs/removes system packages" },
  pacman: { baseRisk: "high", reason: "Installs/removes system packages" },
  apk: { baseRisk: "high", reason: "Installs/removes system packages" },
  zypper: { baseRisk: "high", reason: "Installs/removes system packages" },
  port: { baseRisk: "high", reason: "Installs/removes system packages" },

  // ── Shell builtins ─────────────────────────────────────────────────────────
  cd: { baseRisk: "low" },
  pushd: { baseRisk: "low" },
  popd: { baseRisk: "low" },
  export: { baseRisk: "low" },
  unset: { baseRisk: "low" },
  alias: { baseRisk: "low" },
  history: { baseRisk: "low" },
  readonly: {
    baseRisk: "medium",
    reason: "Locks shell variable/function state",
  },
  umask: { baseRisk: "medium", reason: "Changes default file permission mask" },
  declare: { baseRisk: "medium", reason: "Defines shell variables/functions" },
  typeset: { baseRisk: "medium", reason: "Defines shell variables/functions" },
  // DIVERGENCE: checker.ts lists `set` as LOW_RISK. Our registry classifies it
  // as medium because it can modify shell options and behavior.
  set: { baseRisk: "medium", reason: "Modifies shell options" },
  source: { baseRisk: "high", reason: "Executes arbitrary shell script" },
  eval: { baseRisk: "high", reason: "Evaluates arbitrary shell code" },

  // ── Misc tools ─────────────────────────────────────────────────────────────
  // DIVERGENCE: checker.ts lists `xargs` as LOW_RISK. Our registry classifies
  // it as medium because it executes commands with piped arguments.
  xargs: {
    baseRisk: "medium",
    complexSyntax: true,
    reason: "Executes command with piped arguments",
  },
  tar: {
    baseRisk: "medium",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {
      valueFlags: [
        "-C",
        "--directory",
        "-f",
        "--file",
        "-I",
        "--use-compress-program",
        "--to-command",
        "--checkpoint-action",
      ],
      pathFlags: {
        "-C": true,
        "--directory": true,
        "-f": true,
        "--file": true,
      },
    },
    complexSyntax: true,
    argRules: [
      {
        id: "tar:to-command",
        flags: ["--to-command"],
        risk: "high",
        reason: "Executes arbitrary command during extraction",
      },
      {
        id: "tar:checkpoint-action",
        flags: ["--checkpoint-action"],
        risk: "high",
        reason: "Executes action at checkpoints",
      },
      {
        id: "tar:use-compress-program",
        flags: ["-I", "--use-compress-program"],
        risk: "high",
        reason: "Executes arbitrary compression program",
      },
    ],
  },
  zip: {
    baseRisk: "medium",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  unzip: {
    baseRisk: "medium",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  gzip: {
    baseRisk: "medium",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  gunzip: {
    baseRisk: "medium",
    sandboxAutoApprove: true,
    filesystemOp: true,
    argSchema: {},
  },
  xz: { baseRisk: "medium", filesystemOp: true, argSchema: {} },
  unxz: { baseRisk: "medium", filesystemOp: true, argSchema: {} },
  bzip2: { baseRisk: "medium", filesystemOp: true, argSchema: {} },
  bunzip2: { baseRisk: "medium", filesystemOp: true, argSchema: {} },
  zstd: { baseRisk: "medium", filesystemOp: true, argSchema: {} },
  unzstd: { baseRisk: "medium", filesystemOp: true, argSchema: {} },
  "7z": { baseRisk: "medium", filesystemOp: true, argSchema: {} },
  "7za": { baseRisk: "medium", filesystemOp: true, argSchema: {} },
  sleep: { baseRisk: "low", argSchema: { positionals: "none" } },
  seq: { baseRisk: "low", argSchema: { positionals: "none" } },
  yes: { baseRisk: "low", argSchema: { positionals: "none" } },
  watch: { baseRisk: "medium", reason: "Repeatedly executes command" },
  tmux: {
    baseRisk: "medium",
    reason: "Runs shell commands in managed sessions",
  },
  screen: {
    baseRisk: "medium",
    reason: "Runs shell commands in managed sessions",
  },

  // ── Version control tools ──────────────────────────────────────────────────
  gh: {
    baseRisk: "low",
    argSchema: { valueFlags: ["--repo", "-R"] },
    subcommands: {
      pr: {
        baseRisk: "low",
        subcommands: {
          view: { baseRisk: "low" },
          list: { baseRisk: "low" },
          create: { baseRisk: "medium" },
          merge: { baseRisk: "high", reason: "Merges pull request" },
        },
      },
      issue: {
        baseRisk: "low",
        subcommands: {
          view: { baseRisk: "low" },
          list: { baseRisk: "low" },
          create: { baseRisk: "medium" },
        },
      },
      repo: {
        baseRisk: "low",
        subcommands: {
          view: { baseRisk: "low" },
          clone: { baseRisk: "low" },
          create: { baseRisk: "high" },
          delete: { baseRisk: "high" },
        },
      },
      api: { baseRisk: "medium", reason: "Makes arbitrary GitHub API calls" },
    },
  },
  svn: {
    baseRisk: "medium",
    subcommands: {
      info: { baseRisk: "low" },
      status: { baseRisk: "low" },
      log: { baseRisk: "low" },
      diff: { baseRisk: "low" },
      update: { baseRisk: "medium" },
      add: { baseRisk: "medium" },
      commit: { baseRisk: "medium" },
      delete: { baseRisk: "high" },
    },
  },
  hg: {
    baseRisk: "medium",
    subcommands: {
      status: { baseRisk: "low" },
      log: { baseRisk: "low" },
      diff: { baseRisk: "low" },
      pull: { baseRisk: "medium" },
      update: { baseRisk: "medium" },
      add: { baseRisk: "medium" },
      commit: { baseRisk: "medium" },
      remove: { baseRisk: "high" },
    },
  },

  // ── Vellum assistant CLI ───────────────────────────────────────────────────
  // Classification matches classifyAssistantSubcommand() from checker.ts exactly.
  assistant: {
    baseRisk: "low",
    subcommands: {
      platform: { baseRisk: "low" },
      backup: { baseRisk: "low" },
      help: { baseRisk: "low" },
      oauth: {
        baseRisk: "low",
        subcommands: {
          token: { baseRisk: "high", reason: "Exposes OAuth token" },
          mode: {
            baseRisk: "low",
            argRules: [
              {
                id: "assistant-oauth-mode:set",
                flags: ["--set"],
                risk: "high",
                reason: "Changes OAuth mode",
              },
            ],
          },
          request: { baseRisk: "medium", reason: "Makes OAuth request" },
          connect: { baseRisk: "medium", reason: "Connects OAuth integration" },
          disconnect: {
            baseRisk: "medium",
            reason: "Disconnects OAuth integration",
          },
        },
      },
      credentials: {
        baseRisk: "low",
        subcommands: {
          reveal: { baseRisk: "high", reason: "Reveals credential value" },
          set: { baseRisk: "high", reason: "Sets credential value" },
          delete: { baseRisk: "high", reason: "Deletes credential" },
        },
      },
      keys: {
        baseRisk: "low",
        subcommands: {
          set: { baseRisk: "high", reason: "Sets key value" },
          delete: { baseRisk: "high", reason: "Deletes key" },
        },
      },
      trust: {
        baseRisk: "low",
        subcommands: {
          remove: { baseRisk: "high", reason: "Removes trust rule" },
          clear: { baseRisk: "high", reason: "Clears all trust rules" },
        },
      },
    },
  },
} satisfies Record<string, CommandRiskSpec>;
