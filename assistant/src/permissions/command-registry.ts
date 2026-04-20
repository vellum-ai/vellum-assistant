/**
 * Default command registry for the bash risk classifier.
 *
 * A data-driven registry of ~100 commands with base risk levels, subcommand
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

// ── Default command registry ──────────────────────────────────────────────────

export const DEFAULT_COMMAND_REGISTRY = {

  // ── Read-only filesystem commands ──────────────────────────────────────────
  ls:       { baseRisk: "low" },
  cat:      { baseRisk: "low", argRules: [
    { id: "cat:sensitive", valuePattern: SENSITIVE_PATHS, risk: "high",
      reason: "Reads sensitive file" },
  ]},
  head:     { baseRisk: "low" },
  tail:     { baseRisk: "low" },
  less:     { baseRisk: "low" },
  more:     { baseRisk: "low" },
  wc:       { baseRisk: "low" },
  file:     { baseRisk: "low" },
  stat:     { baseRisk: "low" },
  du:       { baseRisk: "low" },
  df:       { baseRisk: "low" },
  diff:     { baseRisk: "low" },
  tree:     { baseRisk: "low" },
  pwd:      { baseRisk: "low" },
  realpath: { baseRisk: "low" },
  basename: { baseRisk: "low" },
  dirname:  { baseRisk: "low" },

  // ── Search / filter / text processing ──────────────────────────────────────
  grep:     { baseRisk: "low" },
  rg:       { baseRisk: "low" },
  ag:       { baseRisk: "low" },
  ack:      { baseRisk: "low" },
  sort:     { baseRisk: "low" },
  uniq:     { baseRisk: "low" },
  cut:      { baseRisk: "low" },
  tr:       { baseRisk: "low" },
  sed:      { baseRisk: "low", argRules: [
    { id: "sed:inplace", flags: ["-i", "--in-place"], risk: "medium",
      reason: "Edits files in place" },
  ]},
  awk:      { baseRisk: "low", complexSyntax: true },

  // ── System information (read-only) ─────────────────────────────────────────
  echo:     { baseRisk: "low" },
  printf:   { baseRisk: "low" },
  whoami:   { baseRisk: "low" },
  uname:    { baseRisk: "low" },
  uptime:   { baseRisk: "low" },
  hostname: { baseRisk: "low" },
  date:     { baseRisk: "low" },
  cal:      { baseRisk: "low" },
  id:       { baseRisk: "low" },
  ps:       { baseRisk: "low" },
  free:     { baseRisk: "low" },
  which:    { baseRisk: "low" },
  where:    { baseRisk: "low" },
  whereis:  { baseRisk: "low" },
  type:     { baseRisk: "low" },
  printenv: { baseRisk: "low" },
  man:      { baseRisk: "low" },
  help:     { baseRisk: "low" },
  info:     { baseRisk: "low" },

  // ── Checksum / hex tools ───────────────────────────────────────────────────
  sha256sum: { baseRisk: "low" },
  md5sum:   { baseRisk: "low" },
  xxd:      { baseRisk: "low" },
  hexdump:  { baseRisk: "low" },

  // ── Data processing ────────────────────────────────────────────────────────
  jq:       { baseRisk: "low" },
  yq:       { baseRisk: "low" },

  // ── Find ───────────────────────────────────────────────────────────────────
  // DIVERGENCE: checker.ts lists `find` as LOW_RISK unconditionally. Our
  // registry adds arg rules for -exec/-execdir/-delete which escalate to high.
  find:     { baseRisk: "low", complexSyntax: true, argRules: [
    { id: "find:exec",   flags: ["-exec", "-execdir"], risk: "high",
      reason: "Executes arbitrary commands on matched files" },
    { id: "find:delete", flags: ["-delete"],           risk: "high",
      reason: "Deletes matched files" },
  ]},
  fd:       { baseRisk: "low" },

  // ── Write commands ─────────────────────────────────────────────────────────
  cp:       { baseRisk: "medium", argRules: [
    { id: "cp:system", valuePattern: SYSTEM_PATHS, risk: "high",
      reason: "Copies to system path" },
  ]},
  mv:       { baseRisk: "medium", argRules: [
    { id: "mv:system", valuePattern: SYSTEM_PATHS, risk: "high",
      reason: "Moves to system path" },
  ]},
  mkdir:    { baseRisk: "medium" },
  touch:    { baseRisk: "medium" },
  // DIVERGENCE: checker.ts lists `tee` as LOW_RISK. Our registry classifies
  // it as medium because it writes to files.
  tee:      { baseRisk: "medium" },

  // ── Delete commands ────────────────────────────────────────────────────────
  rm:       { baseRisk: "high", argRules: [
    { id: "rm:recursive-force", flags: ["-rf", "-fr", "-Rf", "-fR"],
      risk: "high", reason: "Recursive force delete" },
    { id: "rm:recursive", flags: ["-r", "-R", "--recursive"],
      risk: "high", reason: "Recursive delete" },
    { id: "rm:tmp", valuePattern: TMP_PATHS,
      risk: "medium", reason: "Removes temp files" },
    { id: "rm:system", valuePattern: SYSTEM_PATHS,
      risk: "high", reason: "Removes system files" },
    { id: "rm:sensitive", valuePattern: SENSITIVE_PATHS,
      risk: "high", reason: "Removes sensitive files" },
  ]},
  rmdir:    { baseRisk: "high" },

  // ── Network commands ───────────────────────────────────────────────────────
  curl:     { baseRisk: "medium", argRules: [
    { id: "curl:upload-data", flags: ["-d", "--data", "--data-binary", "--data-raw"],
      valuePattern: String.raw`^@`, risk: "high", reason: "Uploads file contents" },
    { id: "curl:upload-file", flags: ["-T", "--upload-file"],
      risk: "high", reason: "Uploads file" },
    { id: "curl:output-sensitive", flags: ["-o", "--output"],
      valuePattern: SENSITIVE_PATHS, risk: "high", reason: "Writes to sensitive path" },
    { id: "curl:localhost", valuePattern: String.raw`^https?://(localhost|127\.0\.0\.1|\[::1\])`,
      risk: "low", reason: "Local request" },
  ]},
  wget:     { baseRisk: "medium" },
  // DIVERGENCE: checker.ts lists `http` (httpie) as LOW_RISK. Our registry
  // classifies it as medium because it can make network requests with side effects.
  http:     { baseRisk: "medium" },
  ping:     { baseRisk: "low" },
  dig:      { baseRisk: "low" },
  nslookup: { baseRisk: "low" },
  ssh:      { baseRisk: "high", reason: "Opens remote shell" },
  scp:      { baseRisk: "high", reason: "Remote file transfer" },
  rsync:    { baseRisk: "high", reason: "Remote file sync" },

  // ── Git ────────────────────────────────────────────────────────────────────
  // Every subcommand in checker.ts's LOW_RISK_GIT_SUBCOMMANDS must appear here.
  // Divergences are noted inline.
  git:      { baseRisk: "medium", subcommands: {
    // LOW_RISK_GIT_SUBCOMMANDS from checker.ts:
    status:    { baseRisk: "low" },
    log:       { baseRisk: "low" },
    diff:      { baseRisk: "low" },
    show:      { baseRisk: "low" },
    branch:    { baseRisk: "low" },
    tag:       { baseRisk: "low", argRules: [
      { id: "git-tag:delete", flags: ["-d", "--delete"], risk: "high",
        reason: "Deletes git tag" },
    ]},
    remote:    { baseRisk: "low" },
    // DIVERGENCE: checker.ts lists `stash` as LOW_RISK. Our registry classifies
    // the base stash command as medium (it modifies working tree), with read-only
    // subcommands (list, show) as low and destructive ones (drop) as high.
    stash:     { baseRisk: "medium", subcommands: {
      list: { baseRisk: "low" },
      show: { baseRisk: "low" },
      drop: { baseRisk: "high", reason: "Permanently drops stashed changes" },
    }},
    blame:     { baseRisk: "low" },
    shortlog:  { baseRisk: "low" },
    describe:  { baseRisk: "low" },
    "rev-parse": { baseRisk: "low" },
    "ls-files":  { baseRisk: "low" },
    "ls-tree":   { baseRisk: "low" },
    "cat-file":  { baseRisk: "low" },
    reflog:    { baseRisk: "low" },
    // Write operations:
    add:       { baseRisk: "medium" },
    commit:    { baseRisk: "medium" },
    checkout:  { baseRisk: "medium" },
    switch:    { baseRisk: "medium" },
    merge:     { baseRisk: "medium" },
    rebase:    { baseRisk: "medium", argRules: [
      { id: "git-rebase:interactive", flags: ["-i", "--interactive"],
        risk: "high", reason: "Interactive rebase rewrites history" },
    ]},
    push:      { baseRisk: "medium", argRules: [
      { id: "git-push:force", flags: ["--force", "-f", "--force-with-lease"],
        risk: "high", reason: "Force push rewrites remote history" },
    ]},
    pull:      { baseRisk: "medium" },
    fetch:     { baseRisk: "low" },
    reset:     { baseRisk: "medium", argRules: [
      { id: "git-reset:hard", flags: ["--hard"],
        risk: "high", reason: "Discards uncommitted changes" },
    ]},
    clean:     { baseRisk: "high", reason: "Removes untracked files" },
    bisect:    { baseRisk: "low" },
    worktree:  { baseRisk: "medium" },
  }},

  // ── Package managers ───────────────────────────────────────────────────────
  // DIVERGENCE: checker.ts lists `npm`, `npx`, `yarn`, `pnpm`, `bun`, `pip`,
  // `pip3` as LOW_RISK. Our registry classifies them as medium (base) because
  // they download and execute code, with subcommand-level overrides.
  npm:      { baseRisk: "medium", subcommands: {
    ls:       { baseRisk: "low" },
    list:     { baseRisk: "low" },
    outdated: { baseRisk: "low" },
    view:     { baseRisk: "low" },
    info:     { baseRisk: "low" },
    install:  { baseRisk: "medium", reason: "Runs lifecycle scripts, downloads code" },
    ci:       { baseRisk: "medium", reason: "Clean install, runs lifecycle scripts" },
    test:     { baseRisk: "high", reason: "Executes arbitrary package scripts" },
    run:      { baseRisk: "high", reason: "Executes arbitrary package scripts" },
    publish:  { baseRisk: "high", reason: "Publishes package to registry" },
  }},
  // DIVERGENCE: checker.ts lists `npx` as LOW_RISK. Our registry classifies it
  // as high because it downloads and executes arbitrary packages.
  npx:      { baseRisk: "high", reason: "Downloads and executes arbitrary packages" },
  yarn:     { baseRisk: "medium", subcommands: {
    list:     { baseRisk: "low" },
    info:     { baseRisk: "low" },
    why:      { baseRisk: "low" },
    install:  { baseRisk: "medium" },
    add:      { baseRisk: "medium" },
    test:     { baseRisk: "high", reason: "Executes arbitrary package scripts" },
    run:      { baseRisk: "high", reason: "Executes arbitrary package scripts" },
  }},
  pnpm:     { baseRisk: "medium", subcommands: {
    list:     { baseRisk: "low" },
    install:  { baseRisk: "medium" },
    add:      { baseRisk: "medium" },
    test:     { baseRisk: "high", reason: "Executes arbitrary package scripts" },
    run:      { baseRisk: "high", reason: "Executes arbitrary package scripts" },
  }},
  // DIVERGENCE: checker.ts lists `bun` as LOW_RISK. Our registry classifies it
  // as medium (base) with subcommand overrides because it can execute code.
  bun:      { baseRisk: "medium", subcommands: {
    install:  { baseRisk: "medium" },
    add:      { baseRisk: "medium" },
    test:     { baseRisk: "high", reason: "Executes arbitrary test code" },
    run:      { baseRisk: "high", reason: "Executes arbitrary scripts" },
  }},
  pip:      { baseRisk: "medium", subcommands: {
    list:     { baseRisk: "low" },
    show:     { baseRisk: "low" },
    install:  { baseRisk: "medium" },
  }},
  pip3:     { baseRisk: "medium", subcommands: {
    list:     { baseRisk: "low" },
    show:     { baseRisk: "low" },
    install:  { baseRisk: "medium" },
  }},
  brew:     { baseRisk: "medium", subcommands: {
    list:     { baseRisk: "low" },
    info:     { baseRisk: "low" },
    search:   { baseRisk: "low" },
    install:  { baseRisk: "medium" },
    uninstall: { baseRisk: "high" },
  }},
  cargo:    { baseRisk: "medium", subcommands: {
    build:    { baseRisk: "medium" },
    test:     { baseRisk: "high", reason: "Executes arbitrary test code" },
    run:      { baseRisk: "high", reason: "Compiles and executes code" },
  }},

  // ── Build tools (inherently opaque) ────────────────────────────────────────
  make:     { baseRisk: "high", reason: "Executes arbitrary Makefile targets" },

  // ── Language runtimes ──────────────────────────────────────────────────────
  // DIVERGENCE: checker.ts lists `node` as LOW_RISK. Our registry classifies it
  // as high because it executes arbitrary JavaScript.
  node:     { baseRisk: "high", reason: "Executes arbitrary JavaScript", argRules: [
    { id: "node:version", flags: ["--version", "-v"], risk: "low",
      reason: "Prints version" },
    { id: "node:eval", flags: ["-e", "--eval"], risk: "high",
      reason: "Evaluates inline JavaScript" },
  ]},
  // DIVERGENCE: checker.ts lists `deno` as LOW_RISK. Our registry classifies it
  // as high because it executes arbitrary code.
  deno:     { baseRisk: "high", reason: "Executes arbitrary code" },
  // DIVERGENCE: checker.ts lists `python` and `python3` as LOW_RISK. Our registry
  // classifies them as high because they execute arbitrary Python code.
  python:   { baseRisk: "high", reason: "Executes arbitrary Python code", argRules: [
    { id: "python:version", flags: ["--version", "-V"], risk: "low",
      reason: "Prints version" },
  ]},
  python3:  { baseRisk: "high", reason: "Executes arbitrary Python code", argRules: [
    { id: "python3:version", flags: ["--version", "-V"], risk: "low",
      reason: "Prints version" },
  ]},
  ruby:     { baseRisk: "high", reason: "Executes arbitrary Ruby code" },
  go:       { baseRisk: "low", subcommands: {
    mod:      { baseRisk: "low" },
    vet:      { baseRisk: "low" },
    version:  { baseRisk: "low" },
    build:    { baseRisk: "medium" },
    test:     { baseRisk: "high", reason: "Executes arbitrary test code" },
    run:      { baseRisk: "high", reason: "Compiles and executes Go code" },
  }},

  // ── Docker ─────────────────────────────────────────────────────────────────
  docker:   { baseRisk: "medium", subcommands: {
    ps:       { baseRisk: "low" },
    images:   { baseRisk: "low" },
    inspect:  { baseRisk: "low" },
    logs:     { baseRisk: "low" },
    info:     { baseRisk: "low" },
    version:  { baseRisk: "low" },
    build:    { baseRisk: "medium" },
    pull:     { baseRisk: "medium" },
    push:     { baseRisk: "high", reason: "Pushes image to registry" },
    run:      { baseRisk: "high", reason: "Runs arbitrary container", argRules: [
      { id: "docker-run:privileged", flags: ["--privileged"],
        risk: "high", reason: "Privileged container with full host access" },
      { id: "docker-run:volume-root", flags: ["-v", "--volume"],
        valuePattern: String.raw`^/:`, risk: "high",
        reason: "Mounts host root filesystem" },
    ]},
    exec:     { baseRisk: "high", reason: "Executes command in running container" },
    rm:       { baseRisk: "high" },
    rmi:      { baseRisk: "high" },
    stop:     { baseRisk: "medium" },
    start:    { baseRisk: "medium" },
  }},

  // ── Privilege / system ─────────────────────────────────────────────────────
  sudo:     { baseRisk: "high", isWrapper: true,
    reason: "Elevates to superuser privileges" },
  su:       { baseRisk: "high", reason: "Switches user identity" },
  doas:     { baseRisk: "high", isWrapper: true,
    reason: "Elevates privileges (OpenBSD sudo alternative)" },
  chmod:    { baseRisk: "high", reason: "Changes file permissions" },
  chown:    { baseRisk: "high", reason: "Changes file ownership" },
  chgrp:    { baseRisk: "high", reason: "Changes file group" },
  mount:    { baseRisk: "high", reason: "Mounts filesystem" },
  umount:   { baseRisk: "high", reason: "Unmounts filesystem" },
  systemctl: { baseRisk: "high", reason: "Controls system services" },
  service:  { baseRisk: "high", reason: "Controls system services" },
  launchctl: { baseRisk: "high", reason: "Controls macOS services" },

  // ── User management ────────────────────────────────────────────────────────
  useradd:  { baseRisk: "high", reason: "Creates system user" },
  userdel:  { baseRisk: "high", reason: "Deletes system user" },
  usermod:  { baseRisk: "high", reason: "Modifies system user" },
  groupadd: { baseRisk: "high", reason: "Creates system group" },
  groupdel: { baseRisk: "high", reason: "Deletes system group" },

  // ── Firewall ───────────────────────────────────────────────────────────────
  iptables:     { baseRisk: "high", reason: "Modifies firewall rules" },
  ufw:          { baseRisk: "high", reason: "Modifies firewall rules" },
  "firewall-cmd": { baseRisk: "high", reason: "Modifies firewall rules" },

  // ── System lifecycle ───────────────────────────────────────────────────────
  reboot:   { baseRisk: "high", reason: "Reboots the system" },
  shutdown: { baseRisk: "high", reason: "Shuts down the system" },
  halt:     { baseRisk: "high", reason: "Halts the system" },
  poweroff: { baseRisk: "high", reason: "Powers off the system" },

  // ── Process management ─────────────────────────────────────────────────────
  kill:     { baseRisk: "high", reason: "Sends signal to process" },
  killall:  { baseRisk: "high", reason: "Kills processes by name" },
  pkill:    { baseRisk: "high", reason: "Kills processes by pattern" },

  // ── Catastrophic ───────────────────────────────────────────────────────────
  mkfs:     { baseRisk: "high", reason: "Formats filesystem — destroys all data" },
  dd:       { baseRisk: "high", reason: "Low-level block device copy — can destroy disks" },
  fdisk:    { baseRisk: "high", reason: "Modifies disk partitions" },
  parted:   { baseRisk: "high", reason: "Modifies disk partitions" },

  // ── Wrapper commands ───────────────────────────────────────────────────────
  // These unwrap to find and classify the inner command. The classifier takes
  // max(wrapper.baseRisk, inner.risk).
  env:      { baseRisk: "low", isWrapper: true },
  nice:     { baseRisk: "low", isWrapper: true },
  nohup:    { baseRisk: "low", isWrapper: true },
  timeout:  { baseRisk: "low", isWrapper: true },
  time:     { baseRisk: "low", isWrapper: true },
  command:  { baseRisk: "low", isWrapper: true },
  exec:     { baseRisk: "low", isWrapper: true },
  strace:   { baseRisk: "medium", isWrapper: true, reason: "Traces system calls" },
  ltrace:   { baseRisk: "medium", isWrapper: true, reason: "Traces library calls" },
  ionice:   { baseRisk: "low", isWrapper: true },
  taskset:  { baseRisk: "low", isWrapper: true },

  // ── Shell interpreters ──────────────────────────────────────────────────────
  // These execute arbitrary code via -c, script files, or stdin.
  bash:     { baseRisk: "high", reason: "Executes arbitrary shell commands", complexSyntax: true },
  sh:       { baseRisk: "high", reason: "Executes arbitrary shell commands", complexSyntax: true },
  zsh:      { baseRisk: "high", reason: "Executes arbitrary shell commands", complexSyntax: true },
  dash:     { baseRisk: "high", reason: "Executes arbitrary shell commands", complexSyntax: true },
  fish:     { baseRisk: "high", reason: "Executes arbitrary shell commands", complexSyntax: true },

  // ── Package managers (additional) ──────────────────────────────────────────
  "apt-get": { baseRisk: "high", reason: "Installs/removes system packages" },
  apt:       { baseRisk: "high", reason: "Installs/removes system packages" },
  dnf:       { baseRisk: "high", reason: "Installs/removes system packages" },
  yum:       { baseRisk: "high", reason: "Installs/removes system packages" },
  pacman:    { baseRisk: "high", reason: "Installs/removes system packages" },
  apk:       { baseRisk: "high", reason: "Installs/removes system packages" },

  // ── Shell builtins ─────────────────────────────────────────────────────────
  cd:       { baseRisk: "low" },
  pushd:    { baseRisk: "low" },
  popd:     { baseRisk: "low" },
  export:   { baseRisk: "low" },
  unset:    { baseRisk: "low" },
  alias:    { baseRisk: "low" },
  history:  { baseRisk: "low" },
  // DIVERGENCE: checker.ts lists `set` as LOW_RISK. Our registry classifies it
  // as medium because it can modify shell options and behavior.
  set:      { baseRisk: "medium", reason: "Modifies shell options" },
  source:   { baseRisk: "high", reason: "Executes arbitrary shell script" },
  eval:     { baseRisk: "high", reason: "Evaluates arbitrary shell code" },

  // ── Misc tools ─────────────────────────────────────────────────────────────
  // DIVERGENCE: checker.ts lists `xargs` as LOW_RISK. Our registry classifies
  // it as medium because it executes commands with piped arguments.
  xargs:    { baseRisk: "medium", complexSyntax: true,
    reason: "Executes command with piped arguments" },
  tar:      { baseRisk: "medium", complexSyntax: true },
  zip:      { baseRisk: "medium" },
  unzip:    { baseRisk: "medium" },
  gzip:     { baseRisk: "medium" },
  gunzip:   { baseRisk: "medium" },

  // ── Version control tools ──────────────────────────────────────────────────
  gh:       { baseRisk: "low", subcommands: {
    pr:       { baseRisk: "low", subcommands: {
      view:   { baseRisk: "low" },
      list:   { baseRisk: "low" },
      create: { baseRisk: "medium" },
      merge:  { baseRisk: "high", reason: "Merges pull request" },
    }},
    issue:    { baseRisk: "low", subcommands: {
      view:   { baseRisk: "low" },
      list:   { baseRisk: "low" },
      create: { baseRisk: "medium" },
    }},
    repo:     { baseRisk: "low", subcommands: {
      view:   { baseRisk: "low" },
      clone:  { baseRisk: "low" },
      create: { baseRisk: "high" },
      delete: { baseRisk: "high" },
    }},
    api:      { baseRisk: "medium", reason: "Makes arbitrary GitHub API calls" },
  }},

  // ── Vellum assistant CLI ───────────────────────────────────────────────────
  // Classification matches classifyAssistantSubcommand() from checker.ts exactly.
  assistant: { baseRisk: "low", subcommands: {
    platform: { baseRisk: "low" },
    backup:   { baseRisk: "low" },
    help:     { baseRisk: "low" },
    oauth:    { baseRisk: "low", subcommands: {
      token:      { baseRisk: "high", reason: "Exposes OAuth token" },
      mode:       { baseRisk: "low", argRules: [
        { id: "assistant-oauth-mode:set", flags: ["--set"],
          risk: "high", reason: "Changes OAuth mode" },
      ]},
      request:    { baseRisk: "medium", reason: "Makes OAuth request" },
      connect:    { baseRisk: "medium", reason: "Connects OAuth integration" },
      disconnect: { baseRisk: "medium", reason: "Disconnects OAuth integration" },
    }},
    credentials: { baseRisk: "low", subcommands: {
      reveal: { baseRisk: "high", reason: "Reveals credential value" },
      set:    { baseRisk: "high", reason: "Sets credential value" },
      delete: { baseRisk: "high", reason: "Deletes credential" },
    }},
    keys:      { baseRisk: "low", subcommands: {
      set:    { baseRisk: "high", reason: "Sets key value" },
      delete: { baseRisk: "high", reason: "Deletes key" },
    }},
    trust:     { baseRisk: "low", subcommands: {
      remove: { baseRisk: "high", reason: "Removes trust rule" },
      clear:  { baseRisk: "high", reason: "Clears all trust rules" },
    }},
  }},
} satisfies Record<string, CommandRiskSpec>;
