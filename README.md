# dosya cli

The official command-line interface for [dosya.dev](https://dosya.dev) — manage your files from the terminal.

## Install

Download the latest binary for your platform from the [releases page](https://github.com/dosya-dev/cli/releases), or build from source:

```bash
bun run build
```

### Platform-specific builds

```bash
bun run build:darwin-arm64   # macOS Apple Silicon
bun run build:darwin-x64     # macOS Intel
bun run build:linux-x64      # Linux x64
bun run build:windows-x64    # Windows x64
```

## Authentication

```bash
# Login with API key (get one at dosya.dev/settings/api-keys)
dosya auth login --key dos_xxxxx

# Or set via environment variable
export DOSYA_API_KEY=dos_xxxxx

# Verify authentication
dosya whoami
```

Credentials are stored in `~/.dosya/config.json`.

## Commands

### File Operations

```bash
dosya upload <file|dir>          # Upload files or directories
dosya download <file_id>         # Download a file
dosya ls [workspace_id]          # List files
dosya rm <file_id>               # Delete a file
dosya mv <id> <target>           # Move or rename
dosya share <file_id>            # Create a share link
```

### Upload Options

```bash
dosya upload ./photos -r                    # Recursive directory upload
dosya upload ./data --parallel 8            # Parallel uploads (default: 3)
dosya upload ./file.txt -w <workspace_id>   # Target workspace
dosya upload ./file.txt --folder <id>       # Target folder
```

### Workspace Management

```bash
dosya workspace list             # List workspaces
dosya workspace create           # Create workspace
dosya workspace delete <id>      # Delete workspace
```

### Team

```bash
dosya member list                # List workspace members
dosya member invite              # Invite a member
```

### Configuration

```bash
dosya config get [key]           # Show config
dosya config set <key> <value>   # Set config value
dosya config path                # Show config file location
```

### Utilities

```bash
dosya completion <shell>         # Generate shell completions (bash, zsh, fish)
dosya upgrade                    # Self-update to latest version
dosya uninstall                  # Remove CLI and config
```

## Global Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--json` | `-j` | Machine-readable JSON output |
| `--quiet` | `-q` | Suppress non-essential output |
| `--key <key>` | `-k` | API key override |
| `--workspace <id>` | `-w` | Workspace ID override |
| `--debug` | | Verbose output |
| `--no-color` | | Disable colors |
| `--timeout <sec>` | | Request timeout |

## Features

- **Resumable uploads** — Multipart chunked uploads with progress
- **Parallel operations** — Configurable concurrency
- **Retry logic** — Automatic retries with exponential backoff
- **Cross-platform** — macOS, Linux, Windows binaries
- **Self-update** — `dosya upgrade` for in-place updates
- **Scripting-friendly** — `--json` output mode

## License

[MIT](LICENSE)
