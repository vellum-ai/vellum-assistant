# vel - Vellum Assistant Development Toolkit

A TypeScript CLI toolkit for common development operations in the vellum-assistant monorepo.

## Installation

First, install dependencies:

```bash
cd vel
npm install
```

Build the TypeScript sources:

```bash
npm run build
```

## Usage

From the `vel` directory:

```bash
npm run vel <command>
```

Or from the project root after building:

```bash
node ./vel/dist/index.js <command>
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
