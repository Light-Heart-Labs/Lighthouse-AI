#!/bin/bash
# Auto-discover GGUF models and update ODS configuration files
# Should be called before starting llama-server and other model-consuming services

set -euo pipefail

MODELS_DIR="${1:-.}/data/models"
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Call Python script for model discovery
python3 "$SCRIPTS_DIR/auto-discover-models.py"
