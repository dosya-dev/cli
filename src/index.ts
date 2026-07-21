import { setOutputFlags, EXIT } from "./output";
import { parseArgs } from "./parse-args";
import { setRequestTimeout, runCleanup } from "./runtime";
import { AuthError, NetworkError } from "./errors";
import pkg from "../package.json";

const VERSION = pkg.version;

const HELP = `dosya - file management from the terminal

Usage: dosya <command> [options]

Commands:
  auth login           Authenticate with API key
  auth logout          Clear stored credentials
  upload <file>        Upload a file or folder
  download <id>        Download a file by ID
  share <id>           Generate a share link
  ls [workspace]       List files in workspace
  search <query>       Search files, folders and shares
  info <file>          Show file metadata (alias: stat)
  tree [path]          Print the folder tree
  usage                Show storage usage and quota (alias: df)
  rm <id>              Delete a file or folder
  mv <id> <target>     Move or rename a file or folder
  cp <file> <folder>   Copy a file into a folder
  mkdir <path>         Create a folder
  star <target>        Add files/folders to favourites
  unstar <target>      Remove from favourites
  starred              List favourites
  trash list           List, restore or empty the trash
  versions <file>      List or restore file versions
  sync add             Bidirectional folder sync (add/list/run/watch)
  workspace list       List all workspaces
  workspace create     Create a new workspace
  workspace delete     Delete a workspace
  member list          List workspace members
  member invite        Invite a member
  whoami               Show current user info
  config get [key]     Show config value
  config set <k> <v>   Set a config value
  config path          Show config file location
  completion <shell>   Generate shell completion (bash, zsh, fish)
  uninstall            Remove dosya CLI and config
  upgrade              Upgrade to the latest version

Global flags:
  -j, --json           Output as JSON
  -q, --quiet          Suppress non-essential output
  -k, --key <key>      API key (overrides stored key)
  -w, --workspace <id> Workspace ID
      --debug          Verbose diagnostic output
      --no-color       Disable colors and unicode
      --timeout <sec>  Request timeout in seconds
  -v, --version        Show version
  -h, --help           Show help

Environment variables:
  DOSYA_API_KEY        API key (same as --key)
  DOSYA_API_BASE       API base URL (default: https://api.dosya.dev)
  NO_COLOR             Disable colors and unicode (same as --no-color)

Exit codes:
  0 success   1 error   2 usage   3 auth failure   4 network failure

Run 'dosya <command> --help' for command-specific help.

https://dosya.dev/developer/cli`;

let interrupted = false;

function handleSignal(signal: string, code: number): void {
    if (interrupted) process.exit(code);
    interrupted = true;
    runCleanup();
    process.stderr.write(`\n${signal === "SIGINT" ? "Interrupted" : "Terminated"}.\n`);
    process.exit(code);
}

process.on("SIGINT", () => handleSignal("SIGINT", 130));
process.on("SIGTERM", () => handleSignal("SIGTERM", 143));

async function main(): Promise<void> {
    const { args, flags, multi } = parseArgs(process.argv.slice(2));

    // Set global output mode flags before any command runs
    setOutputFlags({
        quiet: flags.quiet !== undefined,
        debug: flags.debug !== undefined,
        // https://no-color.org — any non-empty value disables styling
        noColor: flags["no-color"] !== undefined || Boolean(process.env.NO_COLOR),
    });
    setRequestTimeout(flags.timeout);

    if (flags.version !== undefined) {
        console.log(`dosya ${VERSION}`);
        return;
    }

    if (args.length === 0) {
        console.log(HELP);
        return;
    }

    const [command, sub, ...rest] = args;

    try {
        switch (command) {
            case "auth": {
                const { login, logout, authHelp } = await import("./commands/auth");
                if (sub === "login") return await login(flags);
                if (sub === "logout") return await logout();
                if (flags.help !== undefined || sub === undefined) { authHelp(); process.exit(sub ? EXIT.USAGE : 0); }
                console.error(`Unknown subcommand: auth ${sub}. Usage: dosya auth login|logout`);
                process.exit(EXIT.USAGE);
                break;
            }

            case "whoami": {
                const { whoami } = await import("./commands/whoami");
                return await whoami(flags);
            }

            case "ls": {
                const { ls } = await import("./commands/ls");
                return await ls([sub, ...rest].filter(Boolean), flags);
            }

            case "search": {
                const { search } = await import("./commands/search");
                return await search([sub, ...rest].filter(Boolean), flags);
            }

            case "info":
            case "stat": {
                const { info } = await import("./commands/info");
                return await info([sub, ...rest].filter(Boolean), flags);
            }

            case "tree": {
                const { tree } = await import("./commands/tree");
                return await tree([sub, ...rest].filter(Boolean), flags);
            }

            case "usage":
            case "df": {
                const { usage } = await import("./commands/usage");
                return await usage(flags);
            }

            case "upload": {
                const { upload } = await import("./commands/upload");
                return await upload([sub, ...rest].filter(Boolean), flags);
            }

            case "download": {
                const { download } = await import("./commands/download");
                return await download([sub, ...rest].filter(Boolean), flags);
            }

            case "share": {
                const { share } = await import("./commands/share");
                return await share([sub, ...rest].filter(Boolean), flags);
            }

            case "rm": {
                const { rm } = await import("./commands/rm");
                return await rm([sub, ...rest].filter(Boolean), flags);
            }

            case "mv": {
                const { mv } = await import("./commands/mv");
                return await mv([sub, ...rest].filter(Boolean), flags);
            }

            case "cp": {
                const { cp } = await import("./commands/cp");
                return await cp([sub, ...rest].filter(Boolean), flags);
            }

            case "mkdir": {
                const { mkdir } = await import("./commands/mkdir");
                return await mkdir([sub, ...rest].filter(Boolean), flags);
            }

            case "star": {
                const { star } = await import("./commands/star");
                return await star([sub, ...rest].filter(Boolean), flags);
            }

            case "unstar": {
                const { unstar } = await import("./commands/star");
                return await unstar([sub, ...rest].filter(Boolean), flags);
            }

            case "starred": {
                const { starred } = await import("./commands/star");
                return await starred(flags);
            }

            case "trash": {
                const { trash } = await import("./commands/trash");
                return await trash([sub, ...rest].filter(Boolean), flags);
            }

            case "versions": {
                const { versions } = await import("./commands/versions");
                return await versions([sub, ...rest].filter(Boolean), flags);
            }

            case "sync": {
                const { sync } = await import("./commands/sync");
                return await sync([sub, ...rest].filter(Boolean), flags, multi);
            }

            case "workspace": {
                const { workspaceList, workspaceUse, workspaceCreate, workspaceDelete, workspaceHelp } = await import("./commands/workspace");
                if (sub === "list") return await workspaceList(flags);
                if (sub === "use") return await workspaceUse(rest, flags);
                if (sub === "create") return await workspaceCreate(flags);
                if (sub === "delete") return await workspaceDelete(rest, flags);
                if (flags.help !== undefined || sub === undefined) { workspaceHelp(); process.exit(sub ? EXIT.USAGE : 0); }
                console.error(`Unknown subcommand: workspace ${sub}. Usage: dosya workspace list|use|create|delete`);
                process.exit(EXIT.USAGE);
                break;
            }

            case "member": {
                const { memberList, memberInvite, memberHelp } = await import("./commands/member");
                if (sub === "list") return await memberList(flags);
                if (sub === "invite") return await memberInvite(flags);
                if (flags.help !== undefined || sub === undefined) { memberHelp(); process.exit(sub ? EXIT.USAGE : 0); }
                console.error(`Unknown subcommand: member ${sub}. Usage: dosya member list|invite`);
                process.exit(EXIT.USAGE);
                break;
            }

            case "config": {
                const { configGet, configSet, configPath, configHelp } = await import("./commands/config-cmd");
                if (sub === "get") return await configGet(rest, flags);
                if (sub === "set") return await configSet(rest, flags);
                if (sub === "path") return await configPath(flags);
                if (flags.help !== undefined || sub === undefined) { configHelp(); process.exit(sub ? EXIT.USAGE : 0); }
                console.error(`Unknown subcommand: config ${sub}. Usage: dosya config get|set|path`);
                process.exit(EXIT.USAGE);
                break;
            }

            case "completion": {
                const { completion } = await import("./commands/completion");
                return completion([sub, ...rest].filter(Boolean), flags);
            }

            case "uninstall": {
                const { uninstall } = await import("./commands/uninstall");
                return await uninstall(flags);
            }

            case "upgrade": {
                const { upgrade } = await import("./commands/upgrade");
                return await upgrade(flags);
            }

            default:
                if (flags.help !== undefined) {
                    console.log(HELP);
                    return;
                }
                console.error(`Unknown command: ${command}. Run 'dosya --help' for usage.`);
                process.exit(EXIT.USAGE);
        }
    } catch (err) {
        runCleanup();

        const message = err instanceof Error ? err.message : String(err);
        console.error(`error: ${message}`);

        if (flags.debug !== undefined && err instanceof Error && err.stack) {
            console.error(err.stack);
        }

        if (err instanceof AuthError) process.exit(EXIT.AUTH);
        if (err instanceof NetworkError) process.exit(EXIT.NETWORK);
        process.exit(EXIT.ERROR);
    }
}

main().catch((err: unknown) => {
    runCleanup();
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT.ERROR);
});
