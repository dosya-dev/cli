import { setOutputFlags, fatal, EXIT } from "./output";
import { parseArgs } from "./parse-args";
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
  rm <id>              Delete a file
  mv <id> <target>     Move or rename a file
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

Run 'dosya <command> --help' for command-specific help.

https://dosya.dev/developer/cli`;

// Handle SIGINT (Ctrl+C) cleanly
process.on("SIGINT", () => {
    process.stderr.write("\nInterrupted.\n");
    process.exit(130);
});

async function main(): Promise<void> {
    const { args, flags } = parseArgs(process.argv.slice(2));

    // Set global output mode flags before any command runs
    setOutputFlags({
        quiet: flags.quiet !== undefined,
        debug: flags.debug !== undefined,
    });

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

            case "workspace": {
                const { workspaceList, workspaceCreate, workspaceDelete, workspaceHelp } = await import("./commands/workspace");
                if (sub === "list") return await workspaceList(flags);
                if (sub === "create") return await workspaceCreate(flags);
                if (sub === "delete") return await workspaceDelete(rest, flags);
                if (flags.help !== undefined || sub === undefined) { workspaceHelp(); process.exit(sub ? EXIT.USAGE : 0); }
                console.error(`Unknown subcommand: workspace ${sub}. Usage: dosya workspace list|create|delete`);
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
        const { AuthError, NetworkError } = await import("./client");

        if (err instanceof AuthError) {
            console.error(`error: ${err.message}`);
            process.exit(EXIT.AUTH);
        }

        if (err instanceof NetworkError) {
            console.error(`error: ${err.message}`);
            process.exit(EXIT.NETWORK);
        }

        const message = (err as Error).message ?? String(err);
        console.error(`error: ${message}`);

        if (flags.debug !== undefined) {
            console.error((err as Error).stack ?? "");
        }

        process.exit(EXIT.ERROR);
    }
}

main();
