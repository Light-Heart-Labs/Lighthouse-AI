#!/usr/bin/env python3
"""
Auto-discover GGUF models in ods/data/models and update configuration files.
Runs on ODS startup to make newly downloaded models available in UI.
"""
import os
import sys
import yaml
from pathlib import Path

def get_model_name(filename):
    """Convert filename to model name."""
    # Remove .gguf extension and use filename as is
    return filename.replace('.gguf', '').replace('.GGUF', '')

def discover_models(models_dir):
    """Discover all GGUF models in the directory."""
    models_dir = Path(models_dir)
    if not models_dir.exists():
        return {}

    models = {}
    for gguf_file in models_dir.glob("**/*.gguf"):
        model_name = get_model_name(gguf_file.name)
        models[model_name] = gguf_file.name

    return models

def update_models_ini(ini_path, discovered_models):
    """Update llama-server models.ini with discovered models."""
    if not discovered_models:
        return

    content = []
    added_models = set()

    # Read existing config and preserve order
    if Path(ini_path).exists():
        with open(ini_path, 'r') as f:
            lines = f.readlines()

        i = 0
        while i < len(lines):
            line = lines[i]
            if line.startswith('[') and line.endswith(']\n'):
                section = line[1:-2]
                added_models.add(section)
                content.append(line)
                # Copy section content
                i += 1
                while i < len(lines) and not lines[i].startswith('['):
                    content.append(lines[i])
                    i += 1
            else:
                i += 1

    # Add new models
    for model_name, filename in sorted(discovered_models.items()):
        if model_name not in added_models:
            content.append(f"\n[{model_name}]\n")
            content.append(f"filename = {filename}\n")
            content.append("load-on-startup = false\n")
            content.append("n-ctx = 32768\n")

    # Write updated config
    os.makedirs(Path(ini_path).parent, exist_ok=True)
    with open(ini_path, 'w') as f:
        f.writelines(content)

def update_litellm_config(config_path, discovered_models):
    """Update litellm YAML config with discovered models."""
    if not discovered_models or not Path(config_path).exists():
        return

    try:
        with open(config_path, 'r') as f:
            config = yaml.safe_load(f)
    except Exception:
        return

    if 'model_list' not in config:
        config['model_list'] = []

    # Get existing model names
    existing_models = {item.get('model_name') for item in config['model_list'] if item.get('model_name') != '*'}

    # Add new models before the wildcard entry
    added_count = 0
    for model_name in sorted(discovered_models.keys()):
        if model_name not in existing_models:
            new_entry = {
                'model_name': model_name,
                'litellm_params': {
                    'model': f'openai/{model_name}',
                    'api_base': 'http://llama-server:8080/v1',
                    'api_key': 'not-needed'
                }
            }
            # Find wildcard entry and insert before it
            wildcard_idx = next((i for i, item in enumerate(config['model_list']) if item.get('model_name') == '*'), len(config['model_list']))
            config['model_list'].insert(wildcard_idx, new_entry)
            added_count += 1

    if added_count > 0:
        try:
            with open(config_path, 'w') as f:
                yaml.dump(config, f, default_flow_style=False, sort_keys=False)
        except Exception:
            pass

def main():
    try:
        models_dir = Path("ods/data/models")

        # Discover models
        discovered = discover_models(models_dir)
        if not discovered:
            return 0

        # Update llama-server models.ini
        models_ini = Path("ods/config/llama-server/models.ini")
        if models_ini.exists():
            update_models_ini(models_ini, discovered)

        # Update litellm configs
        for config_file in ["ods/config/litellm/local.yaml", "ods/config/litellm/hybrid.yaml"]:
            update_litellm_config(config_file, discovered)

        return 0
    except Exception:
        # Silently fail - this is a nice-to-have feature
        return 0

if __name__ == "__main__":
    sys.exit(main())
