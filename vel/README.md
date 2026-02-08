# vel - Vellum Assistant Development Toolkit

A TypeScript CLI toolkit for common development operations in the vellum-assistant monorepo.

## Installation

The easiest way to install `vel` is to run the setup script from the project root:

```bash
./setup.sh
```

This will:
1. Install dependencies in the `vel` directory
2. Build the TypeScript sources
3. Create a symlink at `~/.local/bin/vel` for easy access

If `~/.local/bin` is not in your PATH, add it to your shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Manual Installation

If you prefer to install manually:

```bash
cd vel
npm install
npm run build
```

Then you can run commands directly:

```bash
node ./dist/index.js <command>
```

Or create your own symlink:

```bash
ln -s "$(pwd)/dist/index.js" ~/.local/bin/vel
```

## Usage

After installation via `setup.sh`, simply run:

```bash
vel <command>
```

## Commands

### `vel up`
Start the development environment (all services).

```bash
npm run vel up
```

### `vel down`
Stop the development environment.

```bash
npm run vel down
```

### `vel setup`
Set up the development environment (initial configuration).

```bash
npm run vel setup
```

### `vel ps`
List running services and their status.

```bash
npm run vel ps
```

### `vel help`
Show help information.

```bash
npm run vel help
```

## Development

### Watch Mode

```bash
npm run dev
```

This will watch for changes and rebuild automatically.

### Build

```bash
npm run build
```

## Development Status

🚧 **Early Development** - Commands currently print placeholder messages. Full implementation coming soon!

## Future Features

- Docker Compose orchestration
- Service health checks
- Log tailing
- Database migrations
- And more!
