# Quick Start Guide

Get the Arke Export Orchestrator running in 5 minutes.

## Local Development

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Fly.io Token

The `.dev.vars` file already has a valid Fly.io API token. You're ready to go!

If you need to regenerate it:
```bash
fly tokens create deploy --app arke-mods-export-worker
# Update .dev.vars with the new token
```

### 3. Start Local Dev Server

```bash
npm run dev
```

This starts the worker at `http://localhost:8787`

### 4. Test It

```bash
# Health check
curl http://localhost:8787/health

# Create export job
curl -X POST http://localhost:8787/export/mods \
  -H "Content-Type: application/json" \
  -d '{
    "pi": "01K9Z3K4GMDWTT0VQXYSPC9W6S",
    "options": {
      "recursive": false,
      "includeOcr": true,
      "cheimarrosMode": "full"
    }
  }'

# You'll get a task_id back - use it to check status:
curl http://localhost:8787/status/export_mods_XXXXX_YYYY
```

## Production Deployment

### 1. Create Resources

```bash
# Create KV namespace
wrangler kv:namespace create TASK_STORE
wrangler kv:namespace create TASK_STORE --preview

# Create R2 bucket
wrangler r2 bucket create arke-exports
```

### 2. Update Configuration

Edit `wrangler.jsonc` and replace the KV namespace IDs:

```jsonc
"kv_namespaces": [
  {
    "binding": "TASK_STORE",
    "id": "YOUR_PRODUCTION_ID",      // ← Update this
    "preview_id": "YOUR_PREVIEW_ID"   // ← Update this
  }
]
```

### 3. Set Secret

```bash
# The token from .dev.vars
wrangler secret put FLY_API_TOKEN
# Paste the token when prompted
```

### 4. Deploy

```bash
npm run deploy
```

That's it! Your orchestrator is live at:
```
https://arke-export-orchestrator.YOUR_SUBDOMAIN.workers.dev
```

## Test Production

```bash
curl -X POST https://arke-export-orchestrator.YOUR_SUBDOMAIN.workers.dev/export/mods \
  -H "Content-Type: application/json" \
  -d '{
    "pi": "01K9Z3K4GMDWTT0VQXYSPC9W6S",
    "options": {
      "recursive": false,
      "includeOcr": true
    }
  }'
```

## Useful Commands

```bash
# Stream logs
npm run tail

# List KV keys
wrangler kv:key list --namespace-id YOUR_KV_ID

# List R2 objects
wrangler r2 object list arke-exports

# Check worker status
curl https://arke-export-orchestrator.YOUR_SUBDOMAIN.workers.dev/health
```

## Troubleshooting

**"Namespace not found"**
- Make sure you created the KV namespace and updated `wrangler.jsonc`

**"Unauthorized" from Fly.io**
- Check your `FLY_API_TOKEN` in `.dev.vars` or wrangler secrets

**"Task not found" when checking status**
- Task may have expired (1 hour TTL for processing tasks)
- Check that the task_id is correct

**Worker won't start**
- Run `npm run tail` to see error logs
- Check TypeScript errors: `npx tsc --noEmit`

## Next Steps

- Read [README.md](./README.md) for full documentation
- Read [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed deployment guide
- Check [SUMMARY.md](./SUMMARY.md) for architecture overview
- Review [FUTURE_BATCH_EXPORTS.md](./FUTURE_BATCH_EXPORTS.md) for batch support design

## Support

Check logs:
```bash
# Worker logs
npm run tail

# Fly.io machine logs
fly logs -a arke-mods-export-worker
```
