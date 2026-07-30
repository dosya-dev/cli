# dosya cli

The official command-line interface for [dosya.dev](https://dosya.dev) - manage your files from the terminal.

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

Credentials are stored in `~/.dosya/config.json` (mode `0600`), or under
`$XDG_CONFIG_HOME/dosya/` when that variable is set.

The API base URL defaults to `https://api.dosya.dev` and can be overridden with
`DOSYA_API_BASE` or `dosya config set api_base <url>`.

## Commands

### Addressing files and folders

Most commands accept either an **id** (`file_…`, `fld_…`) or a **path**:

```bash
dosya info reports/q3.pdf                 # path, relative to the default workspace
dosya info ws_abc123:reports/q3.pdf       # explicit workspace prefix
dosya info file_abc123                    # raw id (always works, no lookup)
```

Set a default workspace so you can drop the `ws_…:` prefix:

```bash
dosya workspace use ws_abc123
```

Bulk commands (`rm`, `mv`, `star`/`unstar`, `download --zip`, `share bundle`)
accept `*` / `?` globs in the final path segment:

```bash
dosya rm reports/*.log
dosya download --zip photos/*.jpg -o photos.zip
```

### File Operations

```bash
dosya upload <file|dir>          # Upload files or directories
dosya download <file>            # Download a file (id or path); --zip for many
dosya download -r <folder>       # Download a whole folder tree to disk
dosya ls [workspace_id]          # List files (--query to filter)
dosya search <query>             # Search files, folders and shares
dosya info <file>                # Show metadata without downloading (alias: stat)
dosya tree [path]                # Print the folder tree
dosya usage                      # Storage used / quota / plan (alias: df)
dosya rm <target...>             # Delete files or folders (bulk)
dosya mv <target...> <dest>      # Move or rename files or folders (bulk)
dosya cp <file> <folder>         # Copy a file into a folder
dosya mkdir <path>               # Create a folder (nested paths ok)
dosya share <file>               # Create a share link (see Sharing)
```

### Organizing

```bash
dosya star <target...>           # Add files/folders to favourites
dosya unstar <target...>         # Remove from favourites
dosya starred                    # List favourites

dosya trash list                 # List soft-deleted files
dosya trash restore <id|name>    # Restore from the trash
dosya trash empty --force        # Permanently empty the trash

dosya versions <file>            # List a file's versions
dosya versions restore <file> 2  # Restore version 2 as a new version
dosya upload new.pdf --version-of report.pdf   # Upload a new version
```

### Sharing

```bash
dosya share <file> --expires 7d --password secret   # Create a link
dosya share list                                    # List the workspace's links
dosya share revoke <link_id>                        # Revoke a link
dosya share email <file> --email a@b.com            # Create a link and email it
dosya share bundle a.pdf b.pdf --expires 14d        # Share several files as one link
dosya download --zip a.pdf b.pdf -o bundle.zip      # Download several files as a zip
```

### Download Options

```bash
dosya download <id> -o ./out/               # Output path (file or directory)
dosya download <id> -c 16                   # Parallel connections (default 8, max 16)
dosya download <id> --force                 # Overwrite an existing file
dosya download <id> --no-verify             # Skip the content-integrity check
dosya download <id> -o - | tar xz           # Stream to stdout for pipelines
```

Interrupted downloads resume automatically - re-run the same command.

Downloaded content is verified against the origin's ETag (MD5, or the S3
composite form for multipart objects), so silent corruption is caught rather
than written out as a good file. Formats that can't be checked are skipped
rather than guessed at, so this never produces a false alarm.

### Upload Options

```bash
dosya upload ./photos -r                    # Recursive directory upload
dosya upload ./data --parallel 8            # Parallel uploads (default: 3)
dosya upload ./file.txt -w <workspace_id>   # Target workspace
dosya upload ./file.txt --folder <id>       # Target folder
```

Files over 50 MB use a resumable multipart upload: parts are transferred
concurrently, retried individually, and an interrupted upload picks up where it
stopped when you re-run the same command. Progress is tracked in a
`<file>.dosya-upload` sidecar, which is removed on success and ignored if the
file changes underneath it.

Smaller files use a single request, retried by reopening the stream.

### Sync

Keep a local folder and a workspace folder in sync, in either or both directions.

```bash
dosya sync add ~/Documents ws_abc123:Docs        # Create a two-way sync pair
dosya sync add ./photos ws_abc123:Photos \
  --mode push-safe --exclude '*.tmp'             # Upload-only, ignoring *.tmp
dosya sync list                                  # List configured pairs
dosya sync run --dry-run                         # Show what would change
dosya sync run                                   # Sync once
dosya sync watch                                 # Sync continuously (Ctrl+C to stop)
dosya sync watch --daemon                        # …or run it in the background
dosya sync stop                                  # Stop the background watcher
dosya sync status                                # Tracked files, last sync, daemon state
dosya sync remove <pair-id>                      # Stop syncing (files left in place)
```

**Modes:** `two-way` (default, mirror) · `push` (upload + mirror local deletions) ·
`push-safe` (upload only, never delete on the cloud) · `pull` (download + mirror
cloud deletions) · `pull-safe` (download only, never delete locally).

**Conflicts:** `--conflict last-write-wins` (default) keeps the newer side;
`--conflict keep-both` preserves the local version as `<name> (conflicted copy).<ext>`
and pulls the remote to the original name - both sides are kept, nothing is lost.
A safety valve suppresses deletions when the local scan is incomplete or a
suspicious mass-delete is detected.

**Ignore rules:** pass `--exclude '<glob>'` (repeatable) when adding a pair, or drop
a `.dosyaignore` file at the sync root (one glob per line, `#` comments allowed).

**Block-level delta (opt-in):** by default an edited file re-uploads whole. Enable
`dosya config set sync_delta true` and edits to files ≤ 64 MB upload only the
changed blocks (content-defined chunks), reusing everything already stored. New
files and larger files still upload whole. Trade-off: chunks are kept alongside
the assembled file, so delta-synced files use extra storage for the dedup pool.

Transfers are resumable; state lives in `~/.dosya/sync/`.

### Workspace Management

```bash
dosya workspace list             # List workspaces
dosya workspace use <id>         # Set the default workspace
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

## Recipes

Worked examples that combine several commands.

### First-run setup

```bash
dosya auth login --key dos_xxxxx
dosya workspace list                         # copy the workspace id you want
dosya config set default_workspace ws_abc123 # now you can drop -w / ws_…: everywhere
dosya whoami
```

### Upload a project, then share it

```bash
dosya mkdir releases/2026
dosya upload ./dist --recursive --folder <folder_id>
dosya share dist/app.zip --expires 7d --password hunter2
# or bundle several files into one link:
dosya share bundle dist/app.zip dist/notes.md --expires 14d
```

### Find something and download it

```bash
dosya search "invoice"                        # locate it
dosya info reports/2026/invoice.pdf           # inspect before pulling
dosya download reports/2026/invoice.pdf -o ~/Downloads/
# grab several at once as a zip:
dosya download --zip reports/a.pdf reports/b.pdf -o bundle.zip
```

### Keep a folder in sync

```bash
# Two-way mirror of a local folder and a workspace folder:
dosya sync add ~/Documents ws_abc123:Docs
dosya sync run --dry-run                       # preview the plan first
dosya sync run                                 # do it once
dosya sync watch                               # …or keep it live

# Back up a folder without ever letting the cloud delete your local files:
dosya sync add ~/Pictures ws_abc123:Photos --mode push-safe --exclude '*.tmp'
```

### Clean up and recover

```bash
dosya rm old/*.log draft.txt                   # bulk delete (goes to trash)
dosya rm ws_abc123:scratch --force             # delete a whole folder
dosya trash list                               # changed your mind?
dosya trash restore draft.txt                  # bring it back
dosya trash empty --force                      # or purge everything permanently
```

### Versioning

```bash
dosya upload report-final.pdf --version-of report.pdf   # push a new version
dosya versions report.pdf                               # see the history
dosya versions restore report.pdf 2                     # roll back to v2
```

### Scripting with JSON

```bash
# Every command supports --json; combine with jq and meaningful exit codes.
ID=$(dosya upload build.tar.gz --json | jq -r '.file.id')
dosya share "$ID" --json | jq -r '.link.url'
dosya usage --json | jq '.stats | {used: .total_bytes, cap: .storage_cap_bytes}'
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
| `--timeout <sec>` | | Request timeout in seconds |

`NO_COLOR` is honoured as an alias for `--no-color`.

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Runtime error (request failed, partial upload, incomplete download) |
| `2` | Usage error (bad flag, missing argument) |
| `3` | Authentication failure |
| `4` | Network failure |

A recursive upload exits non-zero if any file failed, so scripts can detect
partial success.

## Features

- **Resumable uploads and downloads** - Both survive Ctrl+C and network loss;
  re-running the same command continues from where it stopped
- **Verified downloads** - Content checked against the origin ETag, not just size
- **Parallel operations** - Configurable concurrency for uploads and downloads
- **Retry logic** - Exponential backoff, `Retry-After` aware, and applied only
  to requests that are safe to replay
- **Verified self-update** - `dosya upgrade` checks a published SHA-256 before
  replacing the binary
- **Cross-platform** - macOS, Linux, Windows binaries
- **Scripting-friendly** - `--json` output mode and meaningful exit codes

## Development

```bash
bun install
bun run dev -- whoami   # run from source
bun run typecheck
bun test                # integration tests skip unless an API is reachable
```

Integration tests need `DOSYA_TEST_API_KEY` and (optionally)
`DOSYA_TEST_API_BASE`; without a reachable API they are skipped, not failed.

## Transparency

Every dosya.dev client is source-available. Your files are yours - this repository lets
you verify exactly what the app sends to and receives from our servers: what gets
uploaded, what metadata travels with it, and what comes back. If a claim we make about
privacy or sync behavior can't be verified in this code, open an issue and call it out.

## License

Source-available under the [Dosya Source Available License 1.0](LICENSE):

- **You can** read and audit the code, build and run it with the official
  [dosya.dev](https://dosya.dev) service, and contribute improvements.
- **You can't** redistribute it, use it with any backend other than dosya.dev, or offer
  it as a service.

See [LICENSE](LICENSE) for the exact terms. Versions of this code previously published
under the MIT license remain MIT for those who obtained them then.

## Contributing

Issues and pull requests are welcome. By submitting a contribution you license it to
dosya.dev under the contribution terms in [LICENSE](LICENSE).

## Security

Found a vulnerability? Please report it privately via
[GitHub private vulnerability reporting](../../security/advisories/new) rather than a
public issue.

## The dosya.dev client family

| Repository | What it is | License |
|---|---|---|
| [desktop](https://github.com/dosya-dev/desktop) | Desktop client - sync, upload, manage | Source-available |
| [cli](https://github.com/dosya-dev/cli) | Command-line interface | Source-available |
| [app.dosya.dev](https://github.com/dosya-dev/app.dosya.dev) | Web application | Source-available |
| [shared](https://github.com/dosya-dev/shared) | Shared TypeScript types & utilities | Source-available |
| [dosya-js](https://github.com/dosya-dev/dosya-js) | Official JavaScript SDK | MIT |
| [dosya-java](https://github.com/dosya-dev/dosya-java) | Official Java SDK | MIT |

