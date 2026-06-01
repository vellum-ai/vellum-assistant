// Package main: vellum-evals-runtime — a thin OCI runtime wrapper.
//
// Registered as a named (non-default) runtime of the inner dockerd inside
// the privileged eval-pod. The eval orchestrator selects it for the single
// run/species container with:
//
//	docker run --runtime vellum-evals-runtime \
//	  --annotation ai.vellum.evals.mitm=1 ...
//
// Only that opted-in container is rewritten so it trusts our recording CA
// and inherits the pod netns where iptables NAT redirects to mitmproxy.
// Every other container the inner dockerd creates keeps its own network
// namespace and default trust store. Scoping it this way (rather than as
// the dockerd default-runtime) is a security boundary: untrusted eval /
// species containers and their sidecars must not be silently forced into
// the shared pod netns.
//
// Lifecycle: this binary is invoked once per `docker run` (containerd-shim
// invokes it with arguments matching the runc CLI). On the `create`
// subcommand we read the OCI config.json from the bundle dir and, only if
// the container is opted in (see mitmOptIn), mutate it in place; then we
// exec the real runc. All other subcommands (start, state, kill, delete,
// ...) — and every container that is not opted in — are a pure
// pass-through.
//
// The wrapper exits the moment it execs runc — it does NOT live for the
// lifetime of the container. Networking/TLS interception is the job of
// mitmproxy + iptables in the pod netns, not this binary.
//
// See README.md for the wider eval-pod architecture.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const (
	defaultRealRuncPath = "/usr/bin/runc"
	defaultCAHostPath   = "/etc/eval-pod/recording-ca.pem"

	envRealRunc   = "VELLUM_EVALS_RUNTIME_REAL_RUNC"
	envCAHostPath = "VELLUM_EVALS_RUNTIME_CA_HOST_PATH"
)

// runcSubcommands is the set of subcommands the real runc accepts.
// We only look for `create` in the args; matching against this set is
// how we distinguish the subcommand from a flag value that happens to
// equal the string "create".
var runcSubcommands = map[string]struct{}{
	"checkpoint": {}, "create": {}, "delete": {}, "events": {}, "exec": {},
	"features": {}, "kill": {}, "list": {}, "pause": {}, "ps": {},
	"restore": {}, "resume": {}, "run": {}, "spec": {}, "start": {},
	"state": {}, "update": {},
}

// runcGlobalFlagsWithValue lists runc's global flags that consume the
// NEXT arg as their value. We need this so detectSubcommand can skip
// those values when looking for the subcommand — otherwise a flag value
// like "--log create" would falsely match the create subcommand.
//
// Flags in `--flag=value` form are unaffected because they're a single
// token; the skip logic only applies to space-separated `--flag value`.
var runcGlobalFlagsWithValue = map[string]struct{}{
	"--root":       {},
	"--log":        {},
	"--log-format": {},
	"--criu":       {},
	"--rootless":   {},
}

func main() {
	args := os.Args[1:]
	if sub := detectSubcommand(args); sub == "create" {
		if err := mutateCreateBundle(args); err != nil {
			fmt.Fprintf(os.Stderr, "vellum-evals-runtime: %v\n", err)
			os.Exit(1)
		}
	}
	realRunc := os.Getenv(envRealRunc)
	if realRunc == "" {
		realRunc = defaultRealRuncPath
	}
	execArgs := append([]string{realRunc}, args...)
	if err := syscall.Exec(realRunc, execArgs, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "vellum-evals-runtime: exec %s: %v\n", realRunc, err)
		os.Exit(1)
	}
}

// detectSubcommand walks args left-to-right and returns the first token
// that matches a known runc subcommand. Returns "" if none is found.
//
// Values for runcGlobalFlagsWithValue are skipped so a flag value like
// "--log create" doesn't get mistaken for the create subcommand.
func detectSubcommand(args []string) string {
	skipNext := false
	for _, a := range args {
		if skipNext {
			skipNext = false
			continue
		}
		if _, isValueFlag := runcGlobalFlagsWithValue[a]; isValueFlag {
			skipNext = true
			continue
		}
		if _, ok := runcSubcommands[a]; ok {
			return a
		}
	}
	return ""
}

// mutateCreateBundle finds the bundle dir from args (defaulting to cwd)
// and rewrites <bundle>/config.json with the CA + mount + netns
// mutations from mutate.go.
//
// The rewrite is scoped to the single run/species container the
// orchestrator opted in via the mitmOptInAnnotation. Any container without
// that annotation is left byte-for-byte untouched so its network isolation
// and trust store survive — this is what keeps the wrapper from collapsing
// every container into the shared pod netns.
func mutateCreateBundle(args []string) error {
	bundleDir, err := findBundleDir(args)
	if err != nil {
		return err
	}
	configPath := filepath.Join(bundleDir, "config.json")
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", configPath, err)
	}
	if !mitmOptIn(raw) {
		return nil
	}
	caHost := os.Getenv(envCAHostPath)
	if caHost == "" {
		caHost = defaultCAHostPath
	}
	mutated, err := MutateConfig(raw, caHost)
	if err != nil {
		return fmt.Errorf("mutate %s: %w", configPath, err)
	}
	if err := os.WriteFile(configPath, mutated, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", configPath, err)
	}
	return nil
}

// findBundleDir scans args for --bundle / -b in any of three forms:
//
//	--bundle PATH    -b PATH    --bundle=PATH    -b=PATH
//
// If unset, runc defaults to the current working directory and we mirror
// that. Returns absolute path for clarity.
func findBundleDir(args []string) (string, error) {
	bundle := ""
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--bundle" || a == "-b":
			if i+1 >= len(args) {
				return "", fmt.Errorf("%s flag without value", a)
			}
			bundle = args[i+1]
			i++
		case strings.HasPrefix(a, "--bundle="):
			bundle = strings.TrimPrefix(a, "--bundle=")
		case strings.HasPrefix(a, "-b="):
			bundle = strings.TrimPrefix(a, "-b=")
		}
	}
	if bundle == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return "", fmt.Errorf("getwd: %w", err)
		}
		bundle = cwd
	}
	abs, err := filepath.Abs(bundle)
	if err != nil {
		return "", fmt.Errorf("abs %s: %w", bundle, err)
	}
	return abs, nil
}
