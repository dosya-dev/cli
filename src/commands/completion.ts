import { fatal, EXIT } from "../output";

const HELP = `Generate shell completion scripts.

Usage: dosya completion <shell>

Supported shells: bash, zsh, fish

Examples:
  dosya completion bash >> ~/.bashrc
  dosya completion zsh >> ~/.zshrc
  dosya completion fish > ~/.config/fish/completions/dosya.fish`;

export function completionHelp(): void {
    console.log(HELP);
}

const BASH_COMPLETION = `# dosya bash completion
_dosya_completions() {
    local cur prev commands subcommands
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"

    commands="auth upload download ls search info stat tree usage df mkdir cp star unstar starred trash versions share rm mv sync workspace member whoami config completion uninstall upgrade"
    global_flags="--json --quiet --debug --key --workspace --version --help --no-color --timeout"

    case "\${COMP_WORDS[1]}" in
        auth)
            COMPREPLY=( $(compgen -W "login logout --key --api --help" -- "$cur") )
            return 0
            ;;
        upload)
            if [[ "$cur" == -* ]]; then
                COMPREPLY=( $(compgen -W "--workspace -w --folder --recursive -r --parallel --version-of --json -j --help" -- "$cur") )
            else
                COMPREPLY=( $(compgen -f -- "$cur") )
            fi
            return 0
            ;;
        search)
            COMPREPLY=( $(compgen -W "--workspace -w --type --page --json -j --help" -- "$cur") )
            return 0
            ;;
        info|stat|tree|usage|df)
            COMPREPLY=( $(compgen -W "--workspace -w --json -j --help" -- "$cur") )
            return 0
            ;;
        mkdir|cp|star|unstar|starred)
            COMPREPLY=( $(compgen -W "--workspace -w --json -j --help" -- "$cur") )
            return 0
            ;;
        trash)
            COMPREPLY=( $(compgen -W "list restore empty --workspace -w --force -f --json -j --help" -- "$cur") )
            return 0
            ;;
        versions)
            COMPREPLY=( $(compgen -W "restore --workspace -w --json -j --help" -- "$cur") )
            return 0
            ;;
        sync)
            COMPREPLY=( $(compgen -W "add list status run watch remove --mode --conflict --exclude --dry-run --force -f --workspace -w --json -j --help" -- "$cur") )
            return 0
            ;;
        download)
            COMPREPLY=( $(compgen -W "--output -o --zip --connections -c --force -f --workspace -w --key -k --json -j --help" -- "$cur") )
            return 0
            ;;
        ls)
            COMPREPLY=( $(compgen -W "--workspace -w --folder --query --page --sort --json -j --help" -- "$cur") )
            return 0
            ;;
        share)
            COMPREPLY=( $(compgen -W "list revoke email bundle --password --expires --lock --email --message --workspace -w --json -j --help" -- "$cur") )
            return 0
            ;;
        rm)
            COMPREPLY=( $(compgen -W "--permanent --force -f --json -j --help" -- "$cur") )
            return 0
            ;;
        mv)
            COMPREPLY=( $(compgen -W "--json -j --help" -- "$cur") )
            return 0
            ;;
        workspace)
            if [[ "\${COMP_WORDS[2]}" == "" ]] || [[ $COMP_CWORD -eq 2 ]]; then
                COMPREPLY=( $(compgen -W "list create delete --help" -- "$cur") )
            else
                case "\${COMP_WORDS[2]}" in
                    create) COMPREPLY=( $(compgen -W "--name --json -j --help" -- "$cur") ) ;;
                    delete) COMPREPLY=( $(compgen -W "--force -f --json -j --help" -- "$cur") ) ;;
                    list)   COMPREPLY=( $(compgen -W "--json -j --help" -- "$cur") ) ;;
                esac
            fi
            return 0
            ;;
        member)
            if [[ "\${COMP_WORDS[2]}" == "" ]] || [[ $COMP_CWORD -eq 2 ]]; then
                COMPREPLY=( $(compgen -W "list invite --help" -- "$cur") )
            else
                case "\${COMP_WORDS[2]}" in
                    list)   COMPREPLY=( $(compgen -W "--workspace -w --json -j --help" -- "$cur") ) ;;
                    invite) COMPREPLY=( $(compgen -W "--workspace -w --email --role --json -j --help" -- "$cur") ) ;;
                esac
            fi
            return 0
            ;;
        whoami)
            COMPREPLY=( $(compgen -W "--json -j --help" -- "$cur") )
            return 0
            ;;
        config)
            if [[ "\${COMP_WORDS[2]}" == "" ]] || [[ $COMP_CWORD -eq 2 ]]; then
                COMPREPLY=( $(compgen -W "get set path --help" -- "$cur") )
            else
                case "\${COMP_WORDS[2]}" in
                    get|set) COMPREPLY=( $(compgen -W "api_base default_workspace" -- "$cur") ) ;;
                esac
            fi
            return 0
            ;;
        completion)
            COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )
            return 0
            ;;
        uninstall|upgrade)
            COMPREPLY=( $(compgen -W "--force -f --help" -- "$cur") )
            return 0
            ;;
    esac

    if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "$global_flags" -- "$cur") )
    else
        COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    fi
}
complete -F _dosya_completions dosya`;

const ZSH_COMPLETION = `#compdef dosya
# dosya zsh completion

_dosya() {
    local -a commands
    commands=(
        'auth:Authenticate with API key'
        'upload:Upload a file or folder'
        'download:Download a file (or --zip many)'
        'ls:List files in workspace'
        'search:Search files, folders and shares'
        'info:Show file metadata'
        'stat:Show file metadata'
        'tree:Print the folder tree'
        'usage:Show storage usage and quota'
        'df:Show storage usage and quota'
        'mkdir:Create a folder'
        'cp:Copy a file into a folder'
        'star:Add to favourites'
        'unstar:Remove from favourites'
        'starred:List favourites'
        'trash:Manage the trash'
        'versions:List or restore file versions'
        'share:Create and manage share links'
        'rm:Delete files or folders'
        'mv:Move or rename files or folders'
        'sync:Bidirectional folder sync'
        'workspace:Manage workspaces'
        'member:Manage workspace members'
        'whoami:Show current user info'
        'config:Manage CLI configuration'
        'completion:Generate shell completion'
        'uninstall:Remove dosya CLI and config'
        'upgrade:Upgrade to the latest version'
    )

    _arguments -C \\
        '--json[Output as JSON]' \\
        '--quiet[Suppress non-essential output]' \\
        '--debug[Verbose diagnostic output]' \\
        '--key[API key override]:key' \\
        '--workspace[Workspace ID]:id' \\
        '--version[Show version]' \\
        '--help[Show help]' \\
        '--no-color[Disable colors]' \\
        '--timeout[Request timeout in seconds]:seconds' \\
        '1:command:->command' \\
        '*::arg:->args'

    case $state in
        command)
            _describe -t commands 'dosya command' commands
            ;;
        args)
            case $words[1] in
                auth)
                    _arguments '1:subcommand:(login logout)'
                    ;;
                upload)
                    _arguments \\
                        '--workspace[Workspace ID]:id' \\
                        '-w[Workspace ID]:id' \\
                        '--folder[Folder ID]:id' \\
                        '--recursive[Upload recursively]' \\
                        '-r[Upload recursively]' \\
                        '--parallel[Concurrent uploads]:count' \\
                        '--version-of[Upload as a new version of a file]:file' \\
                        '--json[Output as JSON]' \\
                        '*:file:_files'
                    ;;
                download)
                    _arguments \\
                        '--output[Output path]:path:_files' \\
                        '-o[Output path]:path:_files' \\
                        '--zip[Download several files as a zip]' \\
                        '--connections[Parallel connections]:count' \\
                        '-c[Parallel connections]:count' \\
                        '--force[Overwrite existing file]' \\
                        '-f[Overwrite existing file]' \\
                        '--workspace[Workspace ID]:id' \\
                        '--json[Output as JSON]' \\
                        '*:file'
                    ;;
                ls)
                    _arguments \\
                        '--workspace[Workspace ID]:id' \\
                        '-w[Workspace ID]:id' \\
                        '--folder[Folder ID]:id' \\
                        '--query[Filter by name]:text' \\
                        '--page[Page number]:number' \\
                        '--sort[Sort order]:(newest oldest largest smallest)' \\
                        '--json[Output as JSON]' \\
                        '1:workspace_id'
                    ;;
                share)
                    _arguments \\
                        '1:subcommand or file:(list revoke email bundle)' \\
                        '--password[Password]:password' \\
                        '--expires[Expiration]:days' \\
                        '--lock[Lock mode]:mode:(none view_only full_lock)' \\
                        '--email[Recipient email]:email' \\
                        '--message[Message]:message' \\
                        '--workspace[Workspace ID]:id' \\
                        '--json[Output as JSON]'
                    ;;
                search)
                    _arguments \\
                        '--workspace[Workspace ID]:id' \\
                        '-w[Workspace ID]:id' \\
                        '--type[Filter kind]:kind:(documents images videos)' \\
                        '--page[Page number]:number' \\
                        '--json[Output as JSON]' \\
                        '1:query'
                    ;;
                sync)
                    _arguments \\
                        '1:subcommand:(add list status run watch remove)' \\
                        '--mode[Sync mode]:mode:(two-way push push-safe pull pull-safe)' \\
                        '--conflict[Conflict strategy]:strategy:(last-write-wins keep-both)' \\
                        '--exclude[Ignore glob]:glob' \\
                        '--dry-run[Plan without transferring]' \\
                        '--force[Skip confirmation]' \\
                        '--json[Output as JSON]'
                    ;;
                trash)
                    _arguments '1:subcommand:(list restore empty)' \\
                        '--workspace[Workspace ID]:id' \\
                        '--force[Skip confirmation]' \\
                        '--json[Output as JSON]'
                    ;;
                versions)
                    _arguments '1:subcommand or file:(restore)' \\
                        '--workspace[Workspace ID]:id' \\
                        '--json[Output as JSON]'
                    ;;
                info|stat|tree|usage|df|mkdir|cp|star|unstar|starred)
                    _arguments \\
                        '--workspace[Workspace ID]:id' \\
                        '-w[Workspace ID]:id' \\
                        '--json[Output as JSON]' \\
                        '*:target'
                    ;;
                rm)
                    _arguments \\
                        '--permanent[Permanent delete]' \\
                        '--force[Skip confirmation]' \\
                        '-f[Skip confirmation]' \\
                        '--json[Output as JSON]' \\
                        '1:file_id'
                    ;;
                mv)
                    _arguments \\
                        '--json[Output as JSON]' \\
                        '1:file_id' \\
                        '2:target'
                    ;;
                workspace)
                    _arguments '1:subcommand:(list create delete)' \\
                        '--name[Workspace name]:name' \\
                        '--force[Skip confirmation]' \\
                        '-f[Skip confirmation]' \\
                        '--json[Output as JSON]'
                    ;;
                member)
                    _arguments '1:subcommand:(list invite)' \\
                        '--workspace[Workspace ID]:id' \\
                        '-w[Workspace ID]:id' \\
                        '--email[Email]:email' \\
                        '--role[Role]:role:(Member Admin)' \\
                        '--json[Output as JSON]'
                    ;;
                config)
                    _arguments '1:subcommand:(get set path)' \\
                        '2:key:(api_base default_workspace)'
                    ;;
                completion)
                    _arguments '1:shell:(bash zsh fish)'
                    ;;
                uninstall|upgrade)
                    _arguments '--force[Skip confirmation / force upgrade]' '-f[Skip confirmation / force upgrade]'
                    ;;
            esac
            ;;
    esac
}

_dosya`;

const FISH_COMPLETION = `# dosya fish completion

# Disable file completions by default
complete -c dosya -f

# Top-level commands
complete -c dosya -n '__fish_use_subcommand' -a 'auth' -d 'Authenticate with API key'
complete -c dosya -n '__fish_use_subcommand' -a 'upload' -d 'Upload a file or folder'
complete -c dosya -n '__fish_use_subcommand' -a 'download' -d 'Download a file by ID'
complete -c dosya -n '__fish_use_subcommand' -a 'ls' -d 'List files in workspace'
complete -c dosya -n '__fish_use_subcommand' -a 'search' -d 'Search files, folders and shares'
complete -c dosya -n '__fish_use_subcommand' -a 'info' -d 'Show file metadata'
complete -c dosya -n '__fish_use_subcommand' -a 'stat' -d 'Show file metadata'
complete -c dosya -n '__fish_use_subcommand' -a 'tree' -d 'Print the folder tree'
complete -c dosya -n '__fish_use_subcommand' -a 'usage' -d 'Show storage usage and quota'
complete -c dosya -n '__fish_use_subcommand' -a 'df' -d 'Show storage usage and quota'
complete -c dosya -n '__fish_use_subcommand' -a 'mkdir' -d 'Create a folder'
complete -c dosya -n '__fish_use_subcommand' -a 'cp' -d 'Copy a file into a folder'
complete -c dosya -n '__fish_use_subcommand' -a 'star' -d 'Add to favourites'
complete -c dosya -n '__fish_use_subcommand' -a 'unstar' -d 'Remove from favourites'
complete -c dosya -n '__fish_use_subcommand' -a 'starred' -d 'List favourites'
complete -c dosya -n '__fish_use_subcommand' -a 'trash' -d 'Manage the trash'
complete -c dosya -n '__fish_use_subcommand' -a 'versions' -d 'List or restore file versions'
complete -c dosya -n '__fish_use_subcommand' -a 'share' -d 'Create and manage share links'
complete -c dosya -n '__fish_use_subcommand' -a 'rm' -d 'Delete files or folders'
complete -c dosya -n '__fish_use_subcommand' -a 'mv' -d 'Move or rename files or folders'
complete -c dosya -n '__fish_use_subcommand' -a 'sync' -d 'Bidirectional folder sync'
complete -c dosya -n '__fish_use_subcommand' -a 'workspace' -d 'Manage workspaces'
complete -c dosya -n '__fish_use_subcommand' -a 'member' -d 'Manage workspace members'
complete -c dosya -n '__fish_use_subcommand' -a 'whoami' -d 'Show current user info'
complete -c dosya -n '__fish_use_subcommand' -a 'config' -d 'Manage CLI configuration'
complete -c dosya -n '__fish_use_subcommand' -a 'completion' -d 'Generate shell completion'
complete -c dosya -n '__fish_use_subcommand' -a 'uninstall' -d 'Remove dosya CLI and config'
complete -c dosya -n '__fish_use_subcommand' -a 'upgrade' -d 'Upgrade to the latest version'

# Global flags
complete -c dosya -l json -s j -d 'Output as JSON'
complete -c dosya -l quiet -s q -d 'Suppress non-essential output'
complete -c dosya -l debug -d 'Verbose diagnostic output'
complete -c dosya -l key -s k -x -d 'API key override'
complete -c dosya -l version -s v -d 'Show version'
complete -c dosya -l help -s h -d 'Show help'
complete -c dosya -l no-color -d 'Disable colors'
complete -c dosya -l timeout -x -d 'Request timeout (seconds)'

# auth subcommands
complete -c dosya -n '__fish_seen_subcommand_from auth' -a 'login' -d 'Authenticate with API key'
complete -c dosya -n '__fish_seen_subcommand_from auth' -a 'logout' -d 'Clear stored credentials'
complete -c dosya -n '__fish_seen_subcommand_from auth; and __fish_seen_subcommand_from login' -l key -x -d 'API key'
complete -c dosya -n '__fish_seen_subcommand_from auth; and __fish_seen_subcommand_from login' -l api -x -d 'API base URL'

# upload flags
complete -c dosya -n '__fish_seen_subcommand_from upload' -l workspace -s w -x -d 'Workspace ID'
complete -c dosya -n '__fish_seen_subcommand_from upload' -l folder -x -d 'Folder ID'
complete -c dosya -n '__fish_seen_subcommand_from upload' -l recursive -s r -d 'Upload recursively'
complete -c dosya -n '__fish_seen_subcommand_from upload' -l parallel -x -d 'Concurrent uploads'
complete -c dosya -n '__fish_seen_subcommand_from upload' -F

# download flags
complete -c dosya -n '__fish_seen_subcommand_from download' -l output -s o -rF -d 'Output path'
complete -c dosya -n '__fish_seen_subcommand_from download' -l connections -s c -x -d 'Parallel connections'
complete -c dosya -n '__fish_seen_subcommand_from download' -l force -s f -d 'Overwrite existing file'

# ls flags
complete -c dosya -n '__fish_seen_subcommand_from ls' -l workspace -s w -x -d 'Workspace ID'
complete -c dosya -n '__fish_seen_subcommand_from ls' -l folder -x -d 'Folder ID'
complete -c dosya -n '__fish_seen_subcommand_from ls' -l page -x -d 'Page number'
complete -c dosya -n '__fish_seen_subcommand_from ls' -l sort -x -a 'newest oldest largest smallest' -d 'Sort order'

# share flags
complete -c dosya -n '__fish_seen_subcommand_from share' -l password -x -d 'Password'
complete -c dosya -n '__fish_seen_subcommand_from share' -l expires -x -d 'Expiration (days)'
complete -c dosya -n '__fish_seen_subcommand_from share' -l lock -x -a 'none view_only full_lock' -d 'Lock mode'

# rm flags
complete -c dosya -n '__fish_seen_subcommand_from rm' -l permanent -d 'Permanent delete'
complete -c dosya -n '__fish_seen_subcommand_from rm' -l force -s f -d 'Skip confirmation'

# workspace subcommands
complete -c dosya -n '__fish_seen_subcommand_from workspace; and not __fish_seen_subcommand_from list create delete' -a 'list' -d 'List workspaces'
complete -c dosya -n '__fish_seen_subcommand_from workspace; and not __fish_seen_subcommand_from list create delete' -a 'create' -d 'Create workspace'
complete -c dosya -n '__fish_seen_subcommand_from workspace; and not __fish_seen_subcommand_from list create delete' -a 'delete' -d 'Delete workspace'
complete -c dosya -n '__fish_seen_subcommand_from workspace; and __fish_seen_subcommand_from create' -l name -x -d 'Workspace name'
complete -c dosya -n '__fish_seen_subcommand_from workspace; and __fish_seen_subcommand_from delete' -l force -s f -d 'Skip confirmation'

# member subcommands
complete -c dosya -n '__fish_seen_subcommand_from member; and not __fish_seen_subcommand_from list invite' -a 'list' -d 'List members'
complete -c dosya -n '__fish_seen_subcommand_from member; and not __fish_seen_subcommand_from list invite' -a 'invite' -d 'Invite member'
complete -c dosya -n '__fish_seen_subcommand_from member' -l workspace -s w -x -d 'Workspace ID'
complete -c dosya -n '__fish_seen_subcommand_from member; and __fish_seen_subcommand_from invite' -l email -x -d 'Email address'
complete -c dosya -n '__fish_seen_subcommand_from member; and __fish_seen_subcommand_from invite' -l role -x -a 'Member Admin' -d 'Role'

# config subcommands
complete -c dosya -n '__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from get set path' -a 'get' -d 'Get config value'
complete -c dosya -n '__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from get set path' -a 'set' -d 'Set config value'
complete -c dosya -n '__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from get set path' -a 'path' -d 'Show config path'
complete -c dosya -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from get set' -a 'api_base default_workspace'

# completion subcommands
complete -c dosya -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish' -d 'Shell type'

# search flags
complete -c dosya -n '__fish_seen_subcommand_from search' -l workspace -s w -x -d 'Workspace ID'
complete -c dosya -n '__fish_seen_subcommand_from search' -l type -x -a 'documents images videos' -d 'Filter kind'

# sync subcommands + flags
complete -c dosya -n '__fish_seen_subcommand_from sync; and not __fish_seen_subcommand_from add list status run watch remove' -a 'add list status run watch remove' -d 'Sync action'
complete -c dosya -n '__fish_seen_subcommand_from sync' -l mode -x -a 'two-way push push-safe pull pull-safe' -d 'Sync mode'
complete -c dosya -n '__fish_seen_subcommand_from sync' -l conflict -x -a 'last-write-wins keep-both' -d 'Conflict strategy'
complete -c dosya -n '__fish_seen_subcommand_from sync' -l exclude -x -d 'Ignore glob'
complete -c dosya -n '__fish_seen_subcommand_from sync' -l dry-run -d 'Plan without transferring'

# trash / versions subcommands
complete -c dosya -n '__fish_seen_subcommand_from trash; and not __fish_seen_subcommand_from list restore empty' -a 'list restore empty' -d 'Trash action'
complete -c dosya -n '__fish_seen_subcommand_from versions; and not __fish_seen_subcommand_from restore' -a 'restore' -d 'Restore a version'

# download --zip
complete -c dosya -n '__fish_seen_subcommand_from download' -l zip -d 'Download several files as a zip'

# ls --query
complete -c dosya -n '__fish_seen_subcommand_from ls' -l query -x -d 'Filter by name'

# upload --version-of
complete -c dosya -n '__fish_seen_subcommand_from upload' -l version-of -x -d 'Upload as a new version of a file'

# uninstall / upgrade flags
complete -c dosya -n '__fish_seen_subcommand_from uninstall upgrade' -l force -s f -d 'Skip confirmation'`;

export function completion(args: string[], flags: Record<string, string>): void {
    if (flags.help !== undefined) { completionHelp(); return; }

    const shell = args[0];
    if (!shell) {
        fatal("Shell required. Usage: dosya completion <bash|zsh|fish>", EXIT.USAGE);
    }

    switch (shell) {
        case "bash":
            console.log(BASH_COMPLETION);
            break;
        case "zsh":
            console.log(ZSH_COMPLETION);
            break;
        case "fish":
            console.log(FISH_COMPLETION);
            break;
        default:
            fatal(`Unsupported shell: ${shell}. Supported: bash, zsh, fish`, EXIT.USAGE);
    }
}
