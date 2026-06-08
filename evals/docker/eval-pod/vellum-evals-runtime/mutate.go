// Package main: OCI spec mutation logic for the vellum-evals-runtime wrapper.
//
// This file contains pure functions that transform an OCI runtime-spec
// config.json so that the resulting container, when created by the real
// runc, is born already trusting our recording CA and sharing the parent
// (pod) network namespace.
//
// MutateConfig is unconditional: it always applies all three mutations to
// whatever spec it is handed. The decision of *which* containers to rewrite
// is a separate policy concern (mitmOptIn) enforced on the create path in
// main.go — only the single run/species container the orchestrator opts in
// is mutated, so sidecars and other containers keep their own network
// namespace and default trust store.
//
// Three mutations, applied in order:
//  1. Append three CA env vars to .process.env
//     (NODE_EXTRA_CA_CERTS, REQUESTS_CA_BUNDLE, SSL_CERT_FILE)
//  2. Append a read-only bind-mount of the host CA file at
//     caHostPath to caContainerPath in .mounts
//  3. Filter .linux.namespaces to drop any { "type": "network" } entry
//     so the container inherits the parent (pod) network namespace and
//     our iptables NAT redirect catches its egress.
//
// We use map[string]any rather than a typed OCI struct on purpose: the
// spec is large and we touch only a few fields. A typed round-trip would
// silently drop any field we hadn't modeled (e.g. .hooks, .annotations,
// .windows). With maps, everything we don't touch passes through bit-
// identical.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

const (
	// CAContainerPath is the path inside the container where the recording
	// CA is bind-mounted. Hardcoded by convention so HTTP libraries can be
	// pointed at it via env vars below.
	CAContainerPath = "/etc/ssl/certs/recording-ca.pem"

	// mitmOptInAnnotation is the OCI annotation key that authorizes the
	// create-time spec rewrite. The eval orchestrator sets it (via
	// `docker run --annotation ai.vellum.evals.mitm=1`) on the single
	// run/species container that should be MITM'd. Its absence is the
	// fail-safe default: any container without it is left byte-for-byte
	// untouched, preserving its own network namespace and trust store.
	// Reverse-domain notation per the OCI annotation guidance:
	// https://github.com/opencontainers/image-spec/blob/main/annotations.md
	mitmOptInAnnotation = "ai.vellum.evals.mitm"
)

// caEnvVars are the three env vars our HTTP-library-of-choice ecosystems
// honor for an extra trusted CA. Order matters only for human-readability.
var caEnvVars = []string{
	"NODE_EXTRA_CA_CERTS=" + CAContainerPath, // Node.js (vellum, openclaw, anything axios/undici)
	"REQUESTS_CA_BUNDLE=" + CAContainerPath,  // Python requests / httpx
	"SSL_CERT_FILE=" + CAContainerPath,       // openssl-based fallbacks (curl, Go, Ruby)
}

// mitmOptIn reports whether the OCI spec carries the opt-in annotation that
// authorizes the MITM rewrite. A container is opted in only when the
// orchestrator explicitly set mitmOptInAnnotation to a truthy value
// ("1" or "true", case-insensitive). A decode failure or a missing/false
// annotation yields false: the fail-safe default is to leave the container
// untouched. This gate is what scopes the wrapper to the run/species
// container even if it is ever (mis-)registered as the inner dockerd's
// default-runtime.
func mitmOptIn(configJSON []byte) bool {
	var spec struct {
		Annotations map[string]string `json:"annotations"`
	}
	if err := json.Unmarshal(configJSON, &spec); err != nil {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(spec.Annotations[mitmOptInAnnotation])) {
	case "1", "true":
		return true
	default:
		return false
	}
}

// MutateConfig takes the raw bytes of an OCI config.json, applies the three
// mutations described in the package doc, and returns the new bytes.
//
// MutateConfig does not itself check the opt-in annotation — callers must
// gate on mitmOptIn first (see mutateCreateBundle). Keeping the check out of
// this function keeps the mutation logic pure and table-testable.
//
// caHostPath is the absolute path on the host (eval-pod) filesystem where
// the recording CA PEM lives. The eval-pod startup script is responsible
// for writing this file before any container is created.
func MutateConfig(configJSON []byte, caHostPath string) ([]byte, error) {
	var spec map[string]any
	// UseNumber() keeps JSON numbers as untyped tokens (json.Number, a string)
	// rather than coercing them through float64. This matters for uint64 fields
	// in the OCI spec (e.g. .process.rlimits[].hard/soft) where values near
	// uint64 max would otherwise lose precision on round-trip:
	//   18446744073709551615 → float64 → "18446744073709552000"
	// json.Marshal re-emits json.Number values as their original literal token,
	// so the bytes survive bit-identical.
	dec := json.NewDecoder(bytes.NewReader(configJSON))
	dec.UseNumber()
	if err := dec.Decode(&spec); err != nil {
		return nil, fmt.Errorf("unmarshal config.json: %w", err)
	}
	if err := appendCAEnvVars(spec); err != nil {
		return nil, fmt.Errorf("append CA env vars: %w", err)
	}
	if err := appendCAMount(spec, caHostPath); err != nil {
		return nil, fmt.Errorf("append CA mount: %w", err)
	}
	if err := dropNetworkNamespace(spec); err != nil {
		return nil, fmt.Errorf("drop network namespace: %w", err)
	}
	out, err := json.MarshalIndent(spec, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("marshal mutated config.json: %w", err)
	}
	return out, nil
}

// appendCAEnvVars adds the three CA env vars to spec.process.env. If
// .process is missing it is created. If .process.env is missing it is
// created. Existing entries (including duplicates of our keys) are kept
// untouched; because env var precedence in the container runtime is
// "last-occurrence wins", appending ours at the end means our values
// take effect even if the image baked in a different NODE_EXTRA_CA_CERTS.
func appendCAEnvVars(spec map[string]any) error {
	process, ok := spec["process"].(map[string]any)
	if !ok {
		process = map[string]any{}
		spec["process"] = process
	}
	env, _ := process["env"].([]any)
	for _, v := range caEnvVars {
		env = append(env, v)
	}
	process["env"] = env
	return nil
}

// appendCAMount adds a read-only bind-mount from caHostPath to
// CAContainerPath. If .mounts is missing it is created.
func appendCAMount(spec map[string]any, caHostPath string) error {
	if caHostPath == "" {
		return fmt.Errorf("caHostPath is empty")
	}
	mounts, _ := spec["mounts"].([]any)
	mounts = append(mounts, map[string]any{
		"destination": CAContainerPath,
		"source":      caHostPath,
		"type":        "bind",
		"options":     []any{"bind", "ro"},
	})
	spec["mounts"] = mounts
	return nil
}

// dropNetworkNamespace removes any { "type": "network" } entry from
// .linux.namespaces. When this entry is present, runc creates a fresh
// netns for the container. When absent, the container inherits the
// caller's netns — for us, that's the eval-pod's netns where iptables
// NAT REDIRECT already routes :443 to mitmproxy on :8443.
//
// If .linux or .linux.namespaces is missing, we no-op: a config with no
// linux section can't have a network namespace to drop anyway.
func dropNetworkNamespace(spec map[string]any) error {
	linux, ok := spec["linux"].(map[string]any)
	if !ok {
		return nil
	}
	namespaces, ok := linux["namespaces"].([]any)
	if !ok {
		return nil
	}
	filtered := make([]any, 0, len(namespaces))
	for _, ns := range namespaces {
		entry, ok := ns.(map[string]any)
		if !ok {
			// preserve unknown shapes
			filtered = append(filtered, ns)
			continue
		}
		if t, _ := entry["type"].(string); t == "network" {
			continue
		}
		filtered = append(filtered, entry)
	}
	linux["namespaces"] = filtered
	return nil
}
