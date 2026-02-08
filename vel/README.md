# vel - Vellum Assistant Development Toolkit

A CLI toolkit for common development operations in the vellum-assistant monorepo.

## Installation

From the project root, you can run `vel` directly:

```bash
./vel/vel <command>
```

Or add it to your PATH for easier access:

```bash
export PATH="$PATH:$(pwd)/vel"
```

## Commands

### `vel up`
Start the development environment (all services).

```bash
vel up
```

### `vel down`
Stop the development environment.

```bash
vel down
```

### `vel setup`
Set up the development environment (initial configuration).

```bash
vel setup
```

### `vel ps`
List running services and their status.

```bash
vel ps
```

### `vel help`
Show help information.

```bash
vel help
```

## Development Status

🚧 **Early Development** - Commands currently print placeholder messages. Full implementation coming soon!

## Future Features

- Docker Compose orchestration
- Service health checks
- Log tailing
- Database migrations
- And more!
