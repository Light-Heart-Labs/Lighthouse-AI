#!/usr/bin/env bash
# End-to-end JSON contract coverage for the functional service probes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/ods-functional-json.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT

mkdir -p "$FIXTURE/bin"
cat > "$FIXTURE/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
url=""
output=""
write_code=false
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
    case "${args[$i]}" in
        http://*) url="${args[$i]}" ;;
        -o) output="${args[$((i + 1))]}" ;;
        -w) write_code=true ;;
    esac
done

case "$url" in
    http://llm.test/v1/models)
        printf '{\n  "data": [\n    {"id": "pretty/model"}\n  ]\n}\n'
        ;;
    http://llm.test/v1/chat/completions)
        printf '{\n  "choices": [\n    {"message": {"content": "4"}}\n  ]\n}\n'
        ;;
    http://tts.test/v1/audio/speech)
        dd if=/dev/zero of="$output" bs=2048 count=1 2>/dev/null
        if $write_code; then
            printf '200'
        fi
        ;;
    http://embeddings.test/embed)
        printf '[\n  [1, 0, -1, 2]\n]\n'
        ;;
    http://whisper.test/v1/audio/transcriptions)
        printf '{\n  "text": "hello world"\n}\n'
        ;;
    *)
        exit 1
        ;;
esac
STUB
chmod +x "$FIXTURE/bin/curl"

output=$(PATH="$FIXTURE/bin:$PATH" \
    LLM_URL=http://llm.test \
    TTS_URL=http://tts.test \
    EMBEDDING_URL=http://embeddings.test \
    WHISPER_URL=http://whisper.test \
    bash "$ROOT_DIR/scripts/ods-test-functional.sh" 2>&1)

grep -F 'Results: 4 passed, 0 failed' <<< "$output" >/dev/null
grep -F 'Embeddings generates vectors (4 dimensions)' <<< "$output" >/dev/null
grep -F "LLM generates correct answer: '4'" <<< "$output" >/dev/null
grep -F "Whisper transcribes correctly: 'hello world'" <<< "$output" >/dev/null

echo "Functional probes accept semantic JSON response contracts"
