import { X509Certificate } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CA_CERT_FILENAME = "ca.pem";
const CA_KEY_FILENAME = "ca-key.pem";
const COMBINED_CA_FILENAME = "combined-ca-bundle.pem";
const ISSUED_DIR = "issued";

/** Well-known system CA bundle paths by platform. */
const SYSTEM_CA_PATHS = [
  "/etc/ssl/cert.pem", // macOS
  "/etc/ssl/certs/ca-certificates.crt", // Debian/Ubuntu
  "/etc/pki/tls/certs/ca-bundle.crt", // RHEL/CentOS/Fedora
  "/etc/ssl/ca-bundle.pem", // openSUSE
];

// Only allow valid hostname characters: alphanumeric, hyphens, dots, and wildcards
const HOSTNAME_RE = /^[a-zA-Z0-9.*-]+$/;

/**
 * Ensure a self-signed CA cert+key exists in `{dataDir}/proxy-ca/`.
 * Idempotent: skips generation if both files already exist.
 */
export async function ensureLocalCA(dataDir: string): Promise<void> {
  const caDir = join(dataDir, "proxy-ca");
  const certPath = join(caDir, CA_CERT_FILENAME);
  const keyPath = join(caDir, CA_KEY_FILENAME);

  // Check if both files already exist
  const [certExists, keyExists] = await Promise.all([
    stat(certPath).then(
      () => true,
      () => false,
    ),
    stat(keyPath).then(
      () => true,
      () => false,
    ),
  ]);

  if (certExists && keyExists) return;

  await mkdir(caDir, { recursive: true });

  // Generate CA key
  const keyProc = Bun.spawn(["openssl", "genrsa", "-out", keyPath, "2048"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const keyExit = await keyProc.exited;
  if (keyExit !== 0) {
    const stderr = await new Response(keyProc.stderr).text();
    throw new Error(`Failed to generate CA key: ${stderr}`);
  }

  // Generate self-signed CA cert (valid 10 years)
  const certProc = Bun.spawn(
    [
      "openssl",
      "req",
      "-new",
      "-x509",
      "-key",
      keyPath,
      "-out",
      certPath,
      "-days",
      "3650",
      "-subj",
      "/CN=Vellum Local Proxy CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const certExit = await certProc.exited;
  if (certExit !== 0) {
    const stderr = await new Response(certProc.stderr).text();
    throw new Error(`Failed to generate CA cert: ${stderr}`);
  }

  // Set strict permissions
  await Promise.all([chmod(keyPath, 0o600), chmod(certPath, 0o644)]);
}

/**
 * Issue a leaf certificate signed by the local CA for the given hostname.
 * Caches issued certs in `{caDir}/issued/{hostname}.pem`.
 * Returns PEM strings for the cert and key.
 */
export async function issueLeafCert(
  caDir: string,
  hostname: string,
): Promise<{ cert: string; key: string }> {
  if (!HOSTNAME_RE.test(hostname)) {
    throw new Error(`Invalid hostname: ${hostname}`);
  }

  const issuedDir = join(caDir, ISSUED_DIR);
  const leafCertPath = join(issuedDir, `${hostname}.pem`);
  const leafKeyPath = join(issuedDir, `${hostname}-key.pem`);

  // Return cached cert if it exists and is signed by the current CA
  const [certExists, keyExists] = await Promise.all([
    stat(leafCertPath).then(
      () => true,
      () => false,
    ),
    stat(leafKeyPath).then(
      () => true,
      () => false,
    ),
  ]);

  if (certExists && keyExists) {
    const [cert, key, caCert] = await Promise.all([
      readFile(leafCertPath, "utf-8"),
      readFile(leafKeyPath, "utf-8"),
      readFile(join(caDir, CA_CERT_FILENAME), "utf-8"),
    ]);

    // Verify cached cert was signed by the current CA, not a previous one
    try {
      const leaf = new X509Certificate(cert);
      const ca = new X509Certificate(caCert);
      if (leaf.checkIssued(ca)) {
        return { cert, key };
      }
    } catch {
      // Cert parsing failed -- fall through to re-issue
    }
  }

  await mkdir(issuedDir, { recursive: true });

  const caCertPath = join(caDir, CA_CERT_FILENAME);
  const caKeyPath = join(caDir, CA_KEY_FILENAME);

  // Generate leaf key
  const keyProc = Bun.spawn(
    ["openssl", "genrsa", "-out", leafKeyPath, "2048"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const keyExit = await keyProc.exited;
  if (keyExit !== 0) {
    const stderr = await new Response(keyProc.stderr).text();
    throw new Error(`Failed to generate leaf key for ${hostname}: ${stderr}`);
  }

  // Generate CSR
  const csrPath = join(issuedDir, `${hostname}.csr`);
  const csrProc = Bun.spawn(
    [
      "openssl",
      "req",
      "-new",
      "-key",
      leafKeyPath,
      "-out",
      csrPath,
      "-subj",
      `/CN=${hostname}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const csrExit = await csrProc.exited;
  if (csrExit !== 0) {
    const stderr = await new Response(csrProc.stderr).text();
    throw new Error(`Failed to generate CSR for ${hostname}: ${stderr}`);
  }

  // Write SAN extension config to a temp file
  const extPath = join(issuedDir, `${hostname}-ext.cnf`);
  await writeFile(extPath, `subjectAltName=DNS:${hostname}\n`);

  // Sign with CA (valid 1 year)
  const signProc = Bun.spawn(
    [
      "openssl",
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      caCertPath,
      "-CAkey",
      caKeyPath,
      "-CAcreateserial",
      "-out",
      leafCertPath,
      "-days",
      "365",
      "-extfile",
      extPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const signExit = await signProc.exited;
  if (signExit !== 0) {
    const stderr = await new Response(signProc.stderr).text();
    throw new Error(`Failed to sign leaf cert for ${hostname}: ${stderr}`);
  }

  const [cert, key] = await Promise.all([
    readFile(leafCertPath, "utf-8"),
    readFile(leafKeyPath, "utf-8"),
  ]);
  return { cert, key };
}

/**
 * Create a combined CA bundle that includes both system root CAs and the
 * proxy CA cert. This is needed for non-Node clients (curl, Python, Go)
 * that don't honor NODE_EXTRA_CA_CERTS -- they use SSL_CERT_FILE instead,
 * which replaces (rather than supplements) the default CA bundle.
 *
 * Idempotent: skips regeneration if the combined bundle is newer than
 * both the system bundle and the proxy CA cert.
 */
export async function ensureCombinedCABundle(
  dataDir: string,
): Promise<string | null> {
  const caDir = join(dataDir, "proxy-ca");
  const caCertPath = join(caDir, CA_CERT_FILENAME);
  const combinedPath = join(caDir, COMBINED_CA_FILENAME);

  // Find the system CA bundle
  let systemBundlePath: string | null = null;
  for (const p of SYSTEM_CA_PATHS) {
    try {
      await stat(p);
      systemBundlePath = p;
      break;
    } catch {
      // not found, try next
    }
  }
  if (!systemBundlePath) return null;

  // Check if combined bundle already exists and is newer than both sources
  try {
    const [combinedSt, caSt, systemSt] = await Promise.all([
      stat(combinedPath),
      stat(caCertPath),
      stat(systemBundlePath),
    ]);
    if (
      combinedSt.mtimeMs > caSt.mtimeMs &&
      combinedSt.mtimeMs > systemSt.mtimeMs
    ) {
      return combinedPath;
    }
  } catch {
    // One or more files missing -- fall through to create
  }

  try {
    const [systemCAs, proxyCACert] = await Promise.all([
      readFile(systemBundlePath, "utf-8"),
      readFile(caCertPath, "utf-8"),
    ]);
    await writeFile(combinedPath, systemCAs + "\n" + proxyCACert);
    return combinedPath;
  } catch {
    return null;
  }
}

/**
 * Return the path to the local CA cert for use as NODE_EXTRA_CA_CERTS.
 */
export function getCAPath(dataDir: string): string {
  return join(dataDir, "proxy-ca", CA_CERT_FILENAME);
}
