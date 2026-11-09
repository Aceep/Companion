# Crêpe's terminal hook: tells her when a command fails or takes long.
# Source it from ~/.bashrc, last if possible:
#
#     source /path/to/crepe/scripts/crepe-shell-hook.bash
#
# It sends `commande_echec` ("make · 2") for a command that failed, and
# `commande_longue` ("npm · 3 min 12 s") for one that took CREPE_LONG_SECONDS
# seconds (60 by default) and succeeded, through the Nudge method of the
# extension. A failed long command is only reported as a failure.
#
# Safe to source anywhere: it prints nothing, keeps `$?` and the prompt
# commands that were already there (string or array form), does nothing in a
# non-interactive shell or before bash 5, and never waits for D-Bus: the call
# is made by a detached process, and a missing gdbus, extension or session
# bus is ignored.
#
# Timing uses PS0, which bash expands once a command has been read and before
# it runs, so no DEBUG trap is taken from anyone. The start time is set by a
# parameter expansion with an assignment, which runs in the shell itself;
# an empty line never expands PS0, so it leaves no start time and is ignored.
# Where PS0 is already used, ours is appended to it.

[[ $- == *i* ]] || return 0
(( BASH_VERSINFO[0] >= 5 )) || return 0
[[ -n ${__crepe_hook_installed-} ]] && return 0
__crepe_hook_installed=1

# The empty array element gives an empty string whatever the start time is.
PS0="${PS0-}"'${__crepe_nothing[${__crepe_started:=$EPOCHSECONDS}]-}'

__crepe_duration_text() {
    local seconds=$1
    if (( seconds >= 3600 )); then
        printf '%d h %02d min' $((seconds / 3600)) $((seconds % 3600 / 60))
    elif (( seconds >= 60 )); then
        printf '%d min %02d s' $((seconds / 60)) $((seconds % 60))
    else
        printf '%d s' "$seconds"
    fi
}

# The command's first word, without a path and past any VAR=value prefix.
# Read from the history: a line kept out of it (HISTCONTROL=ignorespace) is named after the one before.
__crepe_command_name() {
    local line number word
    line=$(HISTTIMEFORMAT= history 1 2>/dev/null) || return 0
    read -r number line <<<"$line"
    for word in $line; do
        [[ $word =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] && continue
        printf '%s' "${word##*/}"
        return 0
    done
    printf 'commande'
}

__crepe_nudge() {
    command -v gdbus >/dev/null 2>&1 || return 0
    [[ -n ${DBUS_SESSION_BUS_ADDRESS-} ]] || return 0
    # Backgrounded from inside a subshell that exits at once: no job notice, nothing to wait for.
    ( { gdbus call --session --timeout 2 --dest org.gnome.Shell \
        --object-path /io/github/aceep/Crepe --method io.github.aceep.Crepe.Nudge \
        "$1" "$2" || true; } >/dev/null 2>&1 & )
    return 0
}

# Runs first among the prompt commands, and hands `$?` back untouched.
__crepe_prompt() {
    local status=$? started=${__crepe_started-}
    unset __crepe_started
    # No start time: the first prompt, or an empty line.
    if [[ -n $started ]] && (( status != 130 && status != 148 )); then
        local elapsed=$((EPOCHSECONDS - started)) threshold=${CREPE_LONG_SECONDS:-60}
        [[ $threshold =~ ^[0-9]+$ ]] || threshold=60
        if (( status != 0 )); then
            __crepe_nudge commande_echec "$(__crepe_command_name) · $status"
        elif (( elapsed >= threshold )); then
            __crepe_nudge commande_longue "$(__crepe_command_name) · $(__crepe_duration_text "$elapsed")"
        fi
    fi
    return "$status"
}

if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a"* ]]; then
    PROMPT_COMMAND=(__crepe_prompt "${PROMPT_COMMAND[@]}")
elif [[ -n ${PROMPT_COMMAND-} ]]; then
    PROMPT_COMMAND="__crepe_prompt;${PROMPT_COMMAND}"
else
    PROMPT_COMMAND=__crepe_prompt
fi
