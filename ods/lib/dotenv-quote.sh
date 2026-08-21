#!/usr/bin/env bash
# Serialize one value for the single-line .env grammar shared by Bash, Docker
# Compose, and ODS's safe environment reader. Newlines cannot be represented
# portably in that grammar, so normalize them to spaces rather than joining
# words or allowing a second assignment line.
dotenv_quote() {
    local value="$1"
    value="${value//$'\r'/ }"
    value="${value//$'\n'/ }"

    # Single quotes are literal in both Bash and Compose. When the value itself
    # contains one, use the double-quoted escape set decoded by safe-env.sh.
    if [[ "$value" == *"'"* ]]; then
        value="${value//\\/\\\\}"
        value="${value//\"/\\\"}"
        value="${value//\$/\\\$}"
        value="${value//\`/\\\`}"
        printf '"%s"\n' "$value"
    else
        printf "'%s'\n" "$value"
    fi
}
