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

    commands="auth upload download ls share rm mv workspace member whoami config completion"
    global_flags="--json --quiet --debug --key --workspace --version --help --no-color --timeout"

    case "\${COMP_WORDS[1]}" in
        auth)
            COMPREPLY=( $(compgen -W "login logout --key --api --help" -- "$cur") )
            return 0
            ;;
        upload)
            if [[ "$cur" == -* ]]; then
                COMPREPLY=( $(compgen -W "--workspace -w --folder --recursive -r --parallel --json -j --help" -- "$cur") )
            else
                COMPREPLY=( $(compgen -f -- "$cur") )
            fi
            return 0
            ;;
        download)
            COMPREPLY=( $(compgen -W "--output -o --key -k --json -j --help" -- "$cur") )
            return 0
            ;;
        ls)
            COMPREPLY=( $(compgen -W "--workspace -w --folder --page --sort --json -j --help" -- "$cur") )
            return 0
            ;;
        share)
            COMPREPLY=( $(compgen -W "--password --expires --lock --json -j --help" -- "$cur") )
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
        'download:Download a file by ID'
        'ls:List files in workspace'
        'share:Generate a share link'
        'rm:Delete a file'
        'mv:Move or rename a file'
        'workspace:Manage workspaces'
        'member:Manage workspace members'
        'whoami:Show current user info'
        'config:Manage CLI configuration'
        'completion:Generate shell completion'
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
                        '--json[Output as JSON]' \\
                        '*:file:_files'
                    ;;
                download)
                    _arguments \\
                        '--output[Output path]:path:_files' \\
                        '-o[Output path]:path:_files' \\
                        '--json[Output as JSON]' \\
                        '1:file_id'
                    ;;
                ls)
                    _arguments \\
                        '--workspace[Workspace ID]:id' \\
                        '-w[Workspace ID]:id' \\
                        '--folder[Folder ID]:id' \\
                        '--page[Page number]:number' \\
                        '--sort[Sort order]:(newest oldest largest smallest)' \\
                        '--json[Output as JSON]' \\
                        '1:workspace_id'
                    ;;
                share)
                    _arguments \\
                        '--password[Password]:password' \\
                        '--expires[Expiration]:days' \\
                        '--lock[Lock mode]:mode' \\
                        '--json[Output as JSON]' \\
                        '1:file_id'
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
complete -c dosya -n '__fish_use_subcommand' -a 'share' -d 'Generate a share link'
complete -c dosya -n '__fish_use_subcommand' -a 'rm' -d 'Delete a file'
complete -c dosya -n '__fish_use_subcommand' -a 'mv' -d 'Move or rename a file'
complete -c dosya -n '__fish_use_subcommand' -a 'workspace' -d 'Manage workspaces'
complete -c dosya -n '__fish_use_subcommand' -a 'member' -d 'Manage workspace members'
complete -c dosya -n '__fish_use_subcommand' -a 'whoami' -d 'Show current user info'
complete -c dosya -n '__fish_use_subcommand' -a 'config' -d 'Manage CLI configuration'
complete -c dosya -n '__fish_use_subcommand' -a 'completion' -d 'Generate shell completion'

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

# ls flags
complete -c dosya -n '__fish_seen_subcommand_from ls' -l workspace -s w -x -d 'Workspace ID'
complete -c dosya -n '__fish_seen_subcommand_from ls' -l folder -x -d 'Folder ID'
complete -c dosya -n '__fish_seen_subcommand_from ls' -l page -x -d 'Page number'
complete -c dosya -n '__fish_seen_subcommand_from ls' -l sort -x -a 'newest oldest largest smallest' -d 'Sort order'

# share flags
complete -c dosya -n '__fish_seen_subcommand_from share' -l password -x -d 'Password'
complete -c dosya -n '__fish_seen_subcommand_from share' -l expires -x -d 'Expiration (days)'
complete -c dosya -n '__fish_seen_subcommand_from share' -l lock -x -d 'Lock mode'

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
complete -c dosya -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish' -d 'Shell type'`;

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
