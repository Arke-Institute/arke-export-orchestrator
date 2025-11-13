#!/bin/bash

# Test spawning a Fly.io machine for arke-mods-export-worker
# This verifies the API works before we build the orchestrator

set -e

# Load environment variables
if [ -f .dev.vars ]; then
  set -a
  source .dev.vars
  set +a
fi

if [ -z "$FLY_API_TOKEN" ]; then
  echo "Error: FLY_API_TOKEN not set"
  exit 1
fi

TASK_ID="test_$(date +%s)_$(uuidgen | cut -d'-' -f1 | tr '[:upper:]' '[:lower:]')"
APP_NAME="arke-mods-export-worker"

echo "Testing Fly.io API..."
echo "App: $APP_NAME"
echo "Task ID: $TASK_ID"
echo ""

# First, let's check if the app exists and what images are available
echo "1. Checking app status..."
curl -s -X GET \
  "https://api.machines.dev/v1/apps/$APP_NAME/machines" \
  -H "Authorization: Bearer $FLY_API_TOKEN" \
  -H "Content-Type: application/json" | jq '.'

echo ""
echo "2. Attempting to spawn a test machine..."

# Spawn a test machine
RESPONSE=$(curl -s -X POST \
  "https://api.machines.dev/v1/apps/$APP_NAME/machines" \
  -H "Authorization: Bearer $FLY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"config\": {
      \"image\": \"registry.fly.io/$APP_NAME:deployment-01K9Z8WHQ1RZE9S7BJYXGHAR5R\",
      \"env\": {
        \"TASK_ID\": \"$TASK_ID\",
        \"PI\": \"01K9Z3K4GMDWTT0VQXYSPC9W6S\",
        \"EXPORT_FORMAT\": \"mods\",
        \"EXPORT_OPTIONS\": \"{\\\"recursive\\\":false,\\\"includeOcr\\\":false,\\\"cheimarrosMode\\\":\\\"skip\\\"}\",
        \"R2_ACCOUNT_ID\": \"test\",
        \"R2_ACCESS_KEY_ID\": \"test\",
        \"R2_SECRET_ACCESS_KEY\": \"test\",
        \"R2_BUCKET\": \"arke-exports\",
        \"CALLBACK_URL\": \"https://webhook.site/test\",
        \"BATCH_ID\": \"single\"
      },
      \"auto_destroy\": true,
      \"restart\": {
        \"policy\": \"no\"
      },
      \"guest\": {
        \"cpu_kind\": \"shared\",
        \"cpus\": 2,
        \"memory_mb\": 1024
      }
    },
    \"region\": \"ord\"
  }")

echo "$RESPONSE" | jq '.'

# Check if successful
if echo "$RESPONSE" | jq -e '.id' > /dev/null; then
  MACHINE_ID=$(echo "$RESPONSE" | jq -r '.id')
  echo ""
  echo "✅ Success! Machine spawned: $MACHINE_ID"
  echo "Machine will auto-destroy after running."
else
  echo ""
  echo "❌ Failed to spawn machine"
  exit 1
fi
