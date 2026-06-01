package main

import (
	"os"
	"path/filepath"
	"testing"
)

// optInConfigJSON is a minimal OCI config.json that carries the MITM opt-in
// annotation, so mutateCreateBundle treats it as the run/species container.
const optInConfigJSON = `{
		"annotations": {"ai.vellum.evals.mitm": "1"},
		"process": {"env": ["PATH=/usr/bin"]},
		"linux": {"namespaces": [{"type": "network"}, {"type": "pid"}]}
	}`

// ---- detectSubcommand ----

func TestDetectSubcommand(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"no args", []string{}, ""},
		{"only global flags", []string{"--debug", "--log", "/tmp/runc.log"}, ""},
		{"plain create", []string{"create", "abc123"}, "create"},
		{"create with bundle flag", []string{"create", "--bundle", "/p", "abc"}, "create"},
		{"create after globals", []string{"--root", "/run/runc", "--log", "/tmp/x.log", "create", "abc"}, "create"},
		{"create after --log-format", []string{"--log-format", "json", "create", "abc"}, "create"},
		{"start subcommand", []string{"start", "abc"}, "start"},
		{"state subcommand", []string{"state", "abc"}, "state"},
		{"delete subcommand", []string{"delete", "abc"}, "delete"},
		{"kill subcommand", []string{"kill", "abc", "TERM"}, "kill"},
		{"exec subcommand", []string{"exec", "-t", "abc", "sh"}, "exec"},
		{"run subcommand", []string{"run", "abc"}, "run"},
		// the false-positive case the skipNext logic guards against
		{"--log value is 'create' string", []string{"--log", "create", "start", "abc"}, "start"},
		{"--root value is 'create' string", []string{"--root", "create", "delete", "abc"}, "delete"},
		// = form is one token, no skip needed
		{"create with --log=create", []string{"--log=create", "create", "abc"}, "create"},
		// unknown subcommand → empty
		{"completely unknown args", []string{"foo", "bar", "baz"}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := detectSubcommand(c.args)
			if got != c.want {
				t.Errorf("detectSubcommand(%v) = %q; want %q", c.args, got, c.want)
			}
		})
	}
}

// ---- findBundleDir ----

func TestFindBundleDir(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string // empty means "expect cwd"
	}{
		{"--bundle space form", []string{"create", "--bundle", "/path/to/bundle", "abc"}, "/path/to/bundle"},
		{"-b space form", []string{"create", "-b", "/path/to/bundle", "abc"}, "/path/to/bundle"},
		{"--bundle equals form", []string{"create", "--bundle=/path/to/bundle", "abc"}, "/path/to/bundle"},
		{"-b equals form", []string{"create", "-b=/path/to/bundle", "abc"}, "/path/to/bundle"},
		{"missing flag → cwd", []string{"create", "abc"}, ""},
		{"after global flags", []string{"--root", "/run/runc", "create", "--bundle", "/x", "abc"}, "/x"},
	}

	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	cwd, _ = filepath.Abs(cwd)

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := findBundleDir(c.args)
			if err != nil {
				t.Fatalf("findBundleDir(%v) errored: %v", c.args, err)
			}
			want := c.want
			if want == "" {
				want = cwd
			}
			if got != want {
				t.Errorf("findBundleDir(%v) = %q; want %q", c.args, got, want)
			}
		})
	}
}

func TestFindBundleDir_FlagWithoutValue(t *testing.T) {
	_, err := findBundleDir([]string{"create", "--bundle"})
	if err == nil {
		t.Fatal("expected error when --bundle has no value")
	}
}

// ---- mutateCreateBundle (integration: real file IO in tmp dir) ----

func TestMutateCreateBundle_RewritesConfigJSON(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")
	if err := os.WriteFile(configPath, []byte(optInConfigJSON), 0o644); err != nil {
		t.Fatalf("seed write: %v", err)
	}

	// arg shape that a real containerd-shim → runtime invocation would have
	args := []string{"create", "--bundle", dir, "test-container"}
	if err := mutateCreateBundle(args); err != nil {
		t.Fatalf("mutateCreateBundle errored: %v", err)
	}

	// re-read and verify the file was actually mutated on disk
	out, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read after mutate: %v", err)
	}
	// fast sanity checks; full coverage of the mutation lives in mutate_test.go
	for _, want := range []string{
		"NODE_EXTRA_CA_CERTS=/etc/ssl/certs/recording-ca.pem",
		"REQUESTS_CA_BUNDLE=/etc/ssl/certs/recording-ca.pem",
		"SSL_CERT_FILE=/etc/ssl/certs/recording-ca.pem",
		"/etc/ssl/certs/recording-ca.pem",
	} {
		if !containsBytes(out, want) {
			t.Errorf("expected %q in mutated config; not found", want)
		}
	}
	// "network" should appear ONLY in the substring of CA mount paths, never as
	// a namespace type entry. Quick check by counting:
	if containsBytes(out, `"type": "network"`) {
		t.Error("network namespace should have been dropped from output")
	}
}

// TestMutateCreateBundle_SkipsWhenNotOptedIn is the security-critical case:
// a container the orchestrator did NOT opt in must be left byte-for-byte
// untouched, so its own network namespace and trust store survive.
func TestMutateCreateBundle_SkipsWhenNotOptedIn(t *testing.T) {
	// GIVEN a config.json that requests its own network namespace but carries
	// no MITM opt-in annotation
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")
	input := `{
		"process": {"env": ["PATH=/usr/bin"]},
		"linux": {"namespaces": [{"type": "network"}, {"type": "pid"}]}
	}`
	if err := os.WriteFile(configPath, []byte(input), 0o644); err != nil {
		t.Fatalf("seed write: %v", err)
	}

	// WHEN the runtime processes the create bundle
	args := []string{"create", "--bundle", dir, "test-container"}
	if err := mutateCreateBundle(args); err != nil {
		t.Fatalf("mutateCreateBundle errored: %v", err)
	}

	// THEN the file is unchanged: the network namespace and default trust
	// store are preserved (no CA env vars, no CA mount injected)
	out, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read after mutate: %v", err)
	}
	if string(out) != input {
		t.Errorf("non-opted-in config should be byte-identical; got:\n%s", out)
	}
	if containsBytes(out, "recording-ca.pem") {
		t.Error("CA must not be injected into a container that did not opt in")
	}
}

func TestMutateCreateBundle_MissingConfigErrors(t *testing.T) {
	dir := t.TempDir()
	args := []string{"create", "--bundle", dir, "test-container"}
	err := mutateCreateBundle(args)
	if err == nil {
		t.Fatal("expected error when config.json is missing")
	}
}

func TestMutateCreateBundle_RespectsCAHostPathEnv(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")
	if err := os.WriteFile(configPath, []byte(`{"annotations": {"ai.vellum.evals.mitm": "1"}}`), 0o644); err != nil {
		t.Fatalf("seed write: %v", err)
	}

	customCA := "/custom/path/to/ca.pem"
	t.Setenv(envCAHostPath, customCA)

	args := []string{"create", "--bundle", dir, "test-container"}
	if err := mutateCreateBundle(args); err != nil {
		t.Fatalf("mutateCreateBundle errored: %v", err)
	}

	out, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read after mutate: %v", err)
	}
	if !containsBytes(out, customCA) {
		t.Errorf("expected custom CA path %q in mutated config; not found:\n%s", customCA, out)
	}
}

func containsBytes(b []byte, s string) bool {
	if len(s) == 0 {
		return true
	}
	for i := 0; i+len(s) <= len(b); i++ {
		if string(b[i:i+len(s)]) == s {
			return true
		}
	}
	return false
}
