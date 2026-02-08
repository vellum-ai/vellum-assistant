#!/bin/bash
set -e

echo "🚀 Setting up vellum-assistant..."
echo ""

# Check if we're in the project root
if [ ! -d "web" ]; then
  echo "❌ Error: web directory not found. Please run this script from the project root."
  exit 1
fi

# Install web dependencies
echo "📦 Installing web dependencies..."
cd web
npm ci
cd ..

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Set up your environment variables (copy web/.env.example to web/.env)"
echo "  2. Run 'cd web && npm run dev' to start the development server"
