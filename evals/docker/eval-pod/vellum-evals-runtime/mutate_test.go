package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

const testCAHostPath = "/etc/eval-pod/recording-ca.pem"

// helper: unmarshal mutated bytes back into a map for assertions
func mutateAndUnmarshal(t *testing.T, in string) map[string]any {
	t.Helper()
	out, err := MutateConfig([]byte(in), testCAHostPath)
	if err != nil {
		t.Fatalf("MutateConfig failed: %v", err)
	}
	var spec map[string]any
	if err := json.Unmarshal(out, &spec); err != nil {
		t.Fatalf("re-unmarshal of mutated output failed: %v\noutput: %s", err, out)
	}
	return spec
}

func envList(t *testing.T, spec map[string]any) []string {
	t.Helper()
	process, ok := spec["process"].(map[string]any)
	if !ok {
		t.Fatal("spec.process is missing or wrong type")
	}
	envAny, ok := process["env"].([]any)
	if !ok {
		t.Fatal("spec.process.env is missing or wrong type")
	}
	out := make([]string, 0, len(envAny))
	for _, v := range envAny {
		s, _ := v.(string)
		out = append(out, s)
	}
	return out
}

func mountList(t *testing.T, spec map[string]any) []map[string]any {
	t.Helper()
	mountsAny, _ := spec["mounts"].([]any)
	out := make([]map[string]any, 0, len(mountsAny))
	for _, m := range mountsAny {
		if mm, ok := m.(map[string]any); ok {
			out = append(out, mm)
		}
	}
	return out
}

func namespaceTypes(t *testing.T, spec map[string]any) []string {
	t.Helper()
	linux, ok := spec["linux"].(map[string]any)
	if !ok {
		return nil
	}
	nsAny, _ := linux["namespaces"].([]any)
	out := make([]string, 0, len(nsAny))
	for _, ns := range nsAny {
		if m, ok := ns.(map[string]any); ok {
			if t, _ := m["type"].(string); t != "" {
				out = append(out, t)
			}
		}
	}
	return out
}

func contains(slice []string, want string) bool {
	for _, s := range slice {
		if s == want {
			return true
		}
	}
	return false
}

// ---- env var mutations ----

func TestMutateConfig_AppendsThreeCAEnvVars(t *testing.T) {
	in := `{
		"process": { "env": ["PATH=/usr/bin", "HOSTNAME=foo"] }
	}`
	spec := mutateAndUnmarshal(t, in)
	env := envList(t, spec)

	for _, want := range []string{
		"PATH=/usr/bin", "HOSTNAME=foo",
		"NODE_EXTRA_CA_CERTS=/etc/ssl/certs/recording-ca.pem",
		"REQUESTS_CA_BUNDLE=/etc/ssl/certs/recording-ca.pem",
		"SSL_CERT_FILE=/etc/ssl/certs/recording-ca.pem",
	} {
		if !contains(env, want) {
			t.Errorf("expected env to contain %q; got %v", want, env)
		}
	}
}

func TestMutateConfig_CAEnvVarsAppendedAtEnd(t *testing.T) {
	// "last wins" precedence means our values must be AFTER any image-baked
	// duplicates. Verify by index.
	in := `{
		"process": {
			"env": [
				"PATH=/usr/bin",
				"NODE_EXTRA_CA_CERTS=/old/path.pem"
			]
		}
	}`
	spec := mutateAndUnmarshal(t, in)
	env := envList(t, spec)

	oldIdx, newIdx := -1, -1
	for i, e := range env {
		if e == "NODE_EXTRA_CA_CERTS=/old/path.pem" {
			oldIdx = i
		}
		if e == "NODE_EXTRA_CA_CERTS=/etc/ssl/certs/recording-ca.pem" {
			newIdx = i
		}
	}
	if oldIdx == -1 || newIdx == -1 {
		t.Fatalf("expected both old and new NODE_EXTRA_CA_CERTS; got %v", env)
	}
	if newIdx <= oldIdx {
		t.Errorf("our NODE_EXTRA_CA_CERTS (idx %d) must come AFTER pre-existing one (idx %d); got %v", newIdx, oldIdx, env)
	}
}

func TestMutateConfig_CreatesProcessIfMissing(t *testing.T) {
	in := `{}`
	spec := mutateAndUnmarshal(t, in)
	env := envList(t, spec)
	if len(env) != 3 {
		t.Errorf("expected 3 env vars when process is absent; got %d: %v", len(env), env)
	}
}

func TestMutateConfig_CreatesEnvIfMissing(t *testing.T) {
	in := `{ "process": {} }`
	spec := mutateAndUnmarshal(t, in)
	env := envList(t, spec)
	if len(env) != 3 {
		t.Errorf("expected 3 env vars when env is absent; got %d: %v", len(env), env)
	}
}

// ---- mount mutations ----

func TestMutateConfig_AppendsBindMount(t *testing.T) {
	in := `{
		"mounts": [{"destination": "/proc", "type": "proc"}]
	}`
	spec := mutateAndUnmarshal(t, in)
	mounts := mountList(t, spec)

	if len(mounts) != 2 {
		t.Fatalf("expected 2 mounts (existing + CA); got %d", len(mounts))
	}
	ca := mounts[1]
	if ca["destination"] != "/etc/ssl/certs/recording-ca.pem" {
		t.Errorf("CA mount destination wrong: %v", ca["destination"])
	}
	if ca["source"] != testCAHostPath {
		t.Errorf("CA mount source wrong: %v", ca["source"])
	}
	if ca["type"] != "bind" {
		t.Errorf("CA mount type wrong: %v", ca["type"])
	}
	opts, ok := ca["options"].([]any)
	if !ok {
		t.Fatalf("CA mount options not a slice: %T", ca["options"])
	}
	if len(opts) != 2 || opts[0] != "bind" || opts[1] != "ro" {
		t.Errorf("CA mount options should be [bind, ro]; got %v", opts)
	}
}

func TestMutateConfig_CreatesMountsIfMissing(t *testing.T) {
	in := `{}`
	spec := mutateAndUnmarshal(t, in)
	mounts := mountList(t, spec)
	if len(mounts) != 1 {
		t.Errorf("expected 1 mount (CA) when mounts is absent; got %d", len(mounts))
	}
}

func TestMutateConfig_ErrorsIfCAHostPathEmpty(t *testing.T) {
	_, err := MutateConfig([]byte(`{}`), "")
	if err == nil {
		t.Fatal("expected error when caHostPath is empty")
	}
	if !strings.Contains(err.Error(), "caHostPath") {
		t.Errorf("expected error mentioning caHostPath; got %v", err)
	}
}

// ---- network namespace mutations ----

func TestMutateConfig_DropsNetworkNamespace(t *testing.T) {
	in := `{
		"linux": {
			"namespaces": [
				{"type": "pid"},
				{"type": "network"},
				{"type": "ipc"},
				{"type": "uts"},
				{"type": "mount"}
			]
		}
	}`
	spec := mutateAndUnmarshal(t, in)
	types := namespaceTypes(t, spec)
	if contains(types, "network") {
		t.Errorf("network namespace should have been dropped; got %v", types)
	}
	for _, want := range []string{"pid", "ipc", "uts", "mount"} {
		if !contains(types, want) {
			t.Errorf("non-network namespace %q should be preserved; got %v", want, types)
		}
	}
}

func TestMutateConfig_NoLinuxSection(t *testing.T) {
	in := `{}`
	_, err := MutateConfig([]byte(in), testCAHostPath)
	if err != nil {
		t.Errorf("missing linux section should not error; got %v", err)
	}
}

func TestMutateConfig_NoNamespacesField(t *testing.T) {
	in := `{ "linux": {} }`
	_, err := MutateConfig([]byte(in), testCAHostPath)
	if err != nil {
		t.Errorf("missing namespaces field should not error; got %v", err)
	}
}

func TestMutateConfig_NamespaceWithPathPreserved(t *testing.T) {
	// OCI spec lets each namespace entry carry a .path field that joins
	// an existing ns instead of creating a new one. We should leave non-
	// network entries fully intact, including .path.
	in := `{
		"linux": {
			"namespaces": [
				{"type": "pid", "path": "/proc/1234/ns/pid"},
				{"type": "network"}
			]
		}
	}`
	spec := mutateAndUnmarshal(t, in)
	linux := spec["linux"].(map[string]any)
	ns := linux["namespaces"].([]any)
	if len(ns) != 1 {
		t.Fatalf("expected 1 namespace after dropping network; got %d", len(ns))
	}
	entry := ns[0].(map[string]any)
	if entry["type"] != "pid" {
		t.Errorf("expected remaining ns type=pid; got %v", entry["type"])
	}
	if entry["path"] != "/proc/1234/ns/pid" {
		t.Errorf("path field should be preserved; got %v", entry["path"])
	}
}

// ---- bit-identical pass-through ----

func TestMutateConfig_PassesThroughUnknownTopLevelFields(t *testing.T) {
	// Fields we don't touch (.hooks, .annotations, .ociVersion, ...) must
	// survive the round-trip bit-identical. This is why we use
	// map[string]any rather than a typed OCI struct.
	in := `{
		"ociVersion": "1.0.2",
		"hostname": "test-container",
		"annotations": {"my.key": "my.value"},
		"hooks": {
			"prestart": [{"path": "/usr/bin/my-hook"}]
		}
	}`
	spec := mutateAndUnmarshal(t, in)

	if spec["ociVersion"] != "1.0.2" {
		t.Errorf("ociVersion lost or mutated: %v", spec["ociVersion"])
	}
	if spec["hostname"] != "test-container" {
		t.Errorf("hostname lost or mutated: %v", spec["hostname"])
	}
	ann, ok := spec["annotations"].(map[string]any)
	if !ok || ann["my.key"] != "my.value" {
		t.Errorf("annotations lost or mutated: %v", spec["annotations"])
	}
	hooks, ok := spec["hooks"].(map[string]any)
	if !ok {
		t.Fatalf("hooks lost: %v", spec["hooks"])
	}
	prestart, ok := hooks["prestart"].([]any)
	if !ok || len(prestart) != 1 {
		t.Fatalf("hooks.prestart lost: %v", hooks["prestart"])
	}
	if prestart[0].(map[string]any)["path"] != "/usr/bin/my-hook" {
		t.Errorf("hook path lost or mutated: %v", prestart[0])
	}
}

// ---- error cases ----

func TestMutateConfig_RejectsInvalidJSON(t *testing.T) {
	_, err := MutateConfig([]byte(`{ not json`), testCAHostPath)
	if err == nil {
		t.Fatal("expected error on invalid JSON")
	}
}

// ---- numeric precision (uint64 preservation) ----

func TestMutateConfig_PreservesLargeUint64Values(t *testing.T) {
	// .process.rlimits[].hard and .soft are uint64 in the OCI spec
	// (runtime-spec/specs-go/config.go: type POSIXRlimit Hard uint64).
	// A naive map[string]any decode coerces numbers through float64,
	// which silently rounds values above 2^53.
	//
	// uint64 max = 18446744073709551615 (2^64 - 1)
	// As float64 it becomes 1.8446744073709552e19, which marshals back
	// as "18446744073709552000" — a *different* value runc may reject
	// or interpret incorrectly. We want bit-identical preservation.
	in := `{
		"process": {
			"rlimits": [
				{ "type": "RLIMIT_NOFILE", "hard": 18446744073709551615, "soft": 1024 }
			]
		}
	}`
	out, err := MutateConfig([]byte(in), testCAHostPath)
	if err != nil {
		t.Fatalf("MutateConfig failed: %v", err)
	}
	if !bytes.Contains(out, []byte("18446744073709551615")) {
		t.Errorf("uint64 max value (18446744073709551615) was not preserved bit-identical; mutated output:\n%s", out)
	}
	if bytes.Contains(out, []byte("18446744073709552000")) {
		t.Errorf("uint64 max value was rounded via float64 to 18446744073709552000; mutated output:\n%s", out)
	}
}

func TestMutateConfig_PreservesIntegerOIDC(t *testing.T) {
	// Smoke test that integer fields we DO touch (env list length,
	// namespace count, etc.) still round-trip correctly for normal-
	// sized integers, AND that integer-shaped fields elsewhere in
	// the spec stay intact.
	in := `{
		"process": {
			"user": { "uid": 1000, "gid": 1000 },
			"env": ["PATH=/usr/bin"]
		},
		"linux": {
			"resources": { "memory": { "limit": 9223372036854775807 } }
		}
	}`
	out, err := MutateConfig([]byte(in), testCAHostPath)
	if err != nil {
		t.Fatalf("MutateConfig failed: %v", err)
	}
	// int64 max — common for unlimited resource caps
	if !bytes.Contains(out, []byte("9223372036854775807")) {
		t.Errorf("int64 max value (9223372036854775807) was not preserved; mutated output:\n%s", out)
	}
	// small uids/gids should still appear as plain integers
	if !bytes.Contains(out, []byte(`"uid": 1000`)) {
		t.Errorf("uid integer was not preserved as plain int; mutated output:\n%s", out)
	}
}

// ---- realistic full-spec smoke test ----

const realisticConfigJSON = `{
	"ociVersion": "1.0.2",
	"process": {
		"terminal": false,
		"user": {"uid": 0, "gid": 0},
		"args": ["sleep", "100"],
		"env": [
			"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			"HOSTNAME=my-container"
		],
		"cwd": "/",
		"capabilities": {
			"bounding": ["CAP_AUDIT_WRITE"],
			"effective": ["CAP_AUDIT_WRITE"]
		},
		"noNewPrivileges": true
	},
	"root": {"path": "rootfs"},
	"hostname": "my-container",
	"mounts": [
		{"destination": "/proc", "type": "proc", "source": "proc"},
		{"destination": "/dev", "type": "tmpfs", "source": "tmpfs"}
	],
	"linux": {
		"namespaces": [
			{"type": "pid"},
			{"type": "network"},
			{"type": "ipc"},
			{"type": "uts"},
			{"type": "mount"}
		],
		"maskedPaths": ["/proc/kcore"],
		"readonlyPaths": ["/proc/asound"]
	}
}`

func TestMutateConfig_RealisticConfig(t *testing.T) {
	spec := mutateAndUnmarshal(t, realisticConfigJSON)

	// env: original 2 + 3 CA = 5
	env := envList(t, spec)
	if len(env) != 5 {
		t.Errorf("expected 5 env vars; got %d: %v", len(env), env)
	}

	// mounts: original 2 + 1 CA = 3
	mounts := mountList(t, spec)
	if len(mounts) != 3 {
		t.Errorf("expected 3 mounts; got %d", len(mounts))
	}
	if mounts[2]["destination"] != "/etc/ssl/certs/recording-ca.pem" {
		t.Errorf("CA mount should be last; got %v", mounts[2])
	}

	// namespaces: 5 minus network = 4
	types := namespaceTypes(t, spec)
	if len(types) != 4 || contains(types, "network") {
		t.Errorf("expected 4 namespaces without network; got %v", types)
	}

	// pass-through: maskedPaths, readonlyPaths, root, capabilities preserved
	linux := spec["linux"].(map[string]any)
	if mp, _ := linux["maskedPaths"].([]any); len(mp) != 1 {
		t.Errorf("maskedPaths lost: %v", linux["maskedPaths"])
	}
	if rp, _ := linux["readonlyPaths"].([]any); len(rp) != 1 {
		t.Errorf("readonlyPaths lost: %v", linux["readonlyPaths"])
	}
	if root, _ := spec["root"].(map[string]any); root == nil || root["path"] != "rootfs" {
		t.Errorf("root section lost: %v", spec["root"])
	}
	process := spec["process"].(map[string]any)
	if caps, _ := process["capabilities"].(map[string]any); caps == nil {
		t.Error("process.capabilities lost")
	}
	if np, _ := process["noNewPrivileges"].(bool); !np {
		t.Errorf("process.noNewPrivileges lost: %v", process["noNewPrivileges"])
	}
}

// ---- opt-in gate (mitmOptIn) ----

// TestMitmOptIn verifies the create-path gate: only a spec whose
// ai.vellum.evals.mitm annotation is truthy authorizes the rewrite; every
// other shape (missing annotation, false/empty value, no annotations block,
// invalid JSON) is treated as "not opted in" so the container is left alone.
func TestMitmOptIn(t *testing.T) {
	// GIVEN a table of OCI config.json shapes and the opt-in verdict each
	// should produce
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"annotation = 1", `{"annotations": {"ai.vellum.evals.mitm": "1"}}`, true},
		{"annotation = true", `{"annotations": {"ai.vellum.evals.mitm": "true"}}`, true},
		{"annotation = TRUE (case-insensitive)", `{"annotations": {"ai.vellum.evals.mitm": "TRUE"}}`, true},
		{"annotation = true with whitespace", `{"annotations": {"ai.vellum.evals.mitm": " true "}}`, true},
		{"annotation = 0", `{"annotations": {"ai.vellum.evals.mitm": "0"}}`, false},
		{"annotation = false", `{"annotations": {"ai.vellum.evals.mitm": "false"}}`, false},
		{"annotation empty string", `{"annotations": {"ai.vellum.evals.mitm": ""}}`, false},
		{"different annotation key", `{"annotations": {"other.key": "1"}}`, false},
		{"annotations block absent", `{"process": {"env": []}}`, false},
		{"empty spec", `{}`, false},
		{"invalid JSON", `{ not json`, false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// WHEN we evaluate the opt-in gate against the spec bytes
			got := mitmOptIn([]byte(c.in))

			// THEN the verdict matches the fail-safe expectation
			if got != c.want {
				t.Errorf("mitmOptIn(%s) = %v; want %v", c.in, got, c.want)
			}
		})
	}
}
