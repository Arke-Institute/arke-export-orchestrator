#!/bin/bash

# Script to generate a Fly.io API token for arke-mods-export-worker
# Run this to create the token needed for the orchestrator

set -e

APP_NAME="arke-mods-export-worker"

echo "Creating Fly.io deploy token for $APP_NAME..."
echo ""
echo "Run this command:"
echo ""
echo "  fly tokens create deploy --app $APP_NAME"
echo ""
echo "Then copy the token and update .dev.vars with:"
echo "  FLY_API_TOKEN=<your_token_here>"
echo ""
echo "Note: Make sure you're logged into fly.io first with 'fly auth login'"
