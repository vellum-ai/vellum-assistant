#!/bin/bash
set -e

echo "🚀 Vellum Assistant Setup"
echo "========================="
echo ""

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ Error: npm is not installed"
    echo "Please install Node.js and npm first: https://nodejs.org/"
    exit 1
fi

echo "📦 Installing web dependencies..."
cd web
npm install

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Set up your .env file (see web/.env.example)"
echo "  2. Run 'cd web && npm run dev' to start the development server"
