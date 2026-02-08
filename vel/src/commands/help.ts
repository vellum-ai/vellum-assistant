export function help(): void {
  console.log(`vel - Vellum Assistant Development Toolkit

USAGE:
    vel <command>

COMMANDS:
    up        Start the development environment
    down      Stop the development environment
    setup     Set up the development environment
    ps        List running services
    help      Show this help message

EXAMPLES:
    vel up      # Start all services
    vel down    # Stop all services
    vel setup   # Run initial setup
    vel ps      # Check running services

For more information, visit: https://github.com/vellum-ai/vellum-assistant`);
}
