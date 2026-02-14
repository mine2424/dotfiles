#!/bin/bash
# macOS notification hook for Codex
# Receives JSON on argv[1] with "last-assistant-message".

payload="${1:-}"

if command -v jq >/dev/null 2>&1; then
    last_message="$(printf '%s' "$payload" | jq -r '."last-assistant-message" // "Codex task completed"' 2>/dev/null)"
else
    last_message="Codex task completed"
fi

# Fallback if extraction failed
if [[ -z "$last_message" || "$last_message" == "null" ]]; then
    last_message="Codex task completed"
fi

# Collapse newlines and escape double quotes for AppleScript
last_message="${last_message//$'\n'/ }"
last_message="${last_message//\"/\\\"}"

sound_file="/System/Library/Sounds/submarine.aiff"
if [[ -f "$sound_file" ]] && command -v afplay >/dev/null 2>&1; then
    afplay "$sound_file" >/dev/null 2>&1 &
fi

osascript -e "display notification \"${last_message}\" with title \"Codex\""
