#!/bin/bash

# Test the complete orchestrator flow
# Usage: ./test-orchestrator-flow.sh [orchestrator_url]

set -e

ORCHESTRATOR_URL="${1:-http://localhost:8787}"
PI="01K9Z3K4GMDWTT0VQXYSPC9W6S"

echo "🚀 Testing Arke Export Orchestrator"
echo "URL: $ORCHESTRATOR_URL"
echo "PI: $PI"
echo ""

# ============================================================================
# 1. Health Check
# ============================================================================
echo "1️⃣ Health check..."
curl -s "$ORCHESTRATOR_URL/health" | jq '.'
echo ""

# ============================================================================
# 2. Create Export Job
# ============================================================================
echo "2️⃣ Creating export job..."
RESPONSE=$(curl -s -X POST "$ORCHESTRATOR_URL/export/mods" \
  -H "Content-Type: application/json" \
  -d "{
    \"pi\": \"$PI\",
    \"options\": {
      \"recursive\": false,
      \"includeOcr\": true,
      \"cheimarrosMode\": \"full\"
    }
  }")

echo "$RESPONSE" | jq '.'

TASK_ID=$(echo "$RESPONSE" | jq -r '.task_id')

if [ "$TASK_ID" = "null" ] || [ -z "$TASK_ID" ]; then
  echo "❌ Failed to create export job"
  exit 1
fi

echo ""
echo "✅ Export job created: $TASK_ID"
echo ""

# ============================================================================
# 3. Poll Status
# ============================================================================
echo "3️⃣ Polling status..."
MAX_ATTEMPTS=60
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  STATUS_RESPONSE=$(curl -s "$ORCHESTRATOR_URL/status/$TASK_ID")
  STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.status')

  echo "Attempt $((ATTEMPT + 1))/$MAX_ATTEMPTS - Status: $STATUS"

  if [ "$STATUS" = "success" ]; then
    echo ""
    echo "✅ Export completed successfully!"
    echo "$STATUS_RESPONSE" | jq '.'
    echo ""

    # ============================================================================
    # 4. Download Result
    # ============================================================================
    echo "4️⃣ Download available at:"
    echo "$ORCHESTRATOR_URL/download/$TASK_ID"
    echo ""
    echo "To download:"
    echo "curl $ORCHESTRATOR_URL/download/$TASK_ID -o export.xml"

    exit 0
  elif [ "$STATUS" = "error" ]; then
    echo ""
    echo "❌ Export failed:"
    echo "$STATUS_RESPONSE" | jq '.'
    exit 1
  fi

  ATTEMPT=$((ATTEMPT + 1))
  sleep 5
done

echo ""
echo "⏱️ Timeout waiting for export to complete"
echo "Final status:"
curl -s "$ORCHESTRATOR_URL/status/$TASK_ID" | jq '.'
