#!/bin/bash
# Creates a self-signed code signing certificate for local development.
# This certificate will be trusted by your Mac for signing apps, which helps
# TCC (permission system) recognize the app consistently across rebuilds.

set -euo pipefail

# Ensure cleanup of sensitive files on exit (success or failure)
trap 'rm -f /tmp/dev-cert.* /tmp/cert-config.txt' EXIT

CERT_NAME="Vellum Development"

echo "Creating self-signed development certificate: $CERT_NAME"
echo

# Check if certificate already exists
if security find-identity -v -p codesigning | grep -q "$CERT_NAME"; then
    echo "✓ Certificate '$CERT_NAME' already exists"
    security find-identity -v -p codesigning | grep "$CERT_NAME"
    exit 0
fi

# Create the certificate
cat > /tmp/cert-config.txt <<EOF
[ req ]
default_bits = 2048
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[ req_distinguished_name ]
CN = $CERT_NAME

[ v3_req ]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

# Generate key and certificate
openssl req -new -newkey rsa:2048 -nodes \
    -keyout /tmp/dev-cert.key \
    -out /tmp/dev-cert.csr \
    -config /tmp/cert-config.txt

openssl x509 -req -days 3650 \
    -in /tmp/dev-cert.csr \
    -signkey /tmp/dev-cert.key \
    -out /tmp/dev-cert.crt \
    -extfile /tmp/cert-config.txt \
    -extensions v3_req

# Convert to p12 for importing
openssl pkcs12 -export \
    -out /tmp/dev-cert.p12 \
    -inkey /tmp/dev-cert.key \
    -in /tmp/dev-cert.crt \
    -passout pass:

# Import into keychain
security import /tmp/dev-cert.p12 -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign

# Trust the certificate for code signing
security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db /tmp/dev-cert.crt

echo
echo "✓ Certificate created and installed successfully!"
echo
security find-identity -v -p codesigning | grep "$CERT_NAME"
echo

# Reset TCC permissions so they can be re-granted to the newly-signed app
BUNDLE_ID="com.vellum.vellum-assistant"
echo "Resetting TCC permissions for $BUNDLE_ID..."
tccutil reset Accessibility "$BUNDLE_ID" 2>/dev/null || true
tccutil reset ScreenCapture "$BUNDLE_ID" 2>/dev/null || true
echo "✓ Permissions reset"

echo
echo "Next steps:"
echo "  1. Rebuild the app: ./build.sh clean && ./build.sh run"
echo "  2. Grant permissions in System Settings when prompted"
echo "  3. Permissions will now persist across rebuilds!"
echo
