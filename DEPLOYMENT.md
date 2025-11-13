# Deployment Guide

Complete guide to deploying the Arke Export Orchestrator to Cloudflare Workers.

## Prerequisites

1. **Cloudflare Account** with Workers plan
2. **Wrangler CLI** installed: `npm install -g wrangler`
3. **Fly.io Account** with `arke-mods-export-worker` app deployed
4. **Fly.io API Token** for spawning machines

## Step-by-Step Deployment

### 1. Authenticate with Cloudflare

```bash
wrangler login
```

### 2. Create KV Namespace

Create a KV namespace for storing task state:

```bash
# Production namespace
wrangler kv:namespace create TASK_STORE

# Preview namespace (for local dev)
wrangler kv:namespace create TASK_STORE --preview
```

You'll get output like:
```
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "TASK_STORE", id = "abc123..." }
```

### 3. Create R2 Bucket

Create an R2 bucket for storing export files:

```bash
wrangler r2 bucket create arke-exports
```

For preview/development:
```bash
wrangler r2 bucket create arke-exports-preview
```

### 4. Update wrangler.jsonc

Update `wrangler.jsonc` with the KV namespace IDs from step 2:

```jsonc
{
  "kv_namespaces": [
    {
      "binding": "TASK_STORE",
      "id": "YOUR_PRODUCTION_KV_ID",      // ← Replace this
      "preview_id": "YOUR_PREVIEW_KV_ID"  // ← Replace this
    }
  ]
}
```

### 5. Set Fly.io Worker Image Tag

Update the worker image tag in `wrangler.jsonc`:

```bash
# Check latest deployment tag
fly image show --app arke-mods-export-worker

# Update wrangler.jsonc:
"FLY_WORKER_IMAGE": "registry.fly.io/arke-mods-export-worker:deployment-XXXXX"
```

Or use `latest` if you tag your deployments:
```jsonc
"FLY_WORKER_IMAGE": "registry.fly.io/arke-mods-export-worker:latest"
```

### 6. Set Secrets

Set the Fly.io API token as a secret:

```bash
# Create deploy token for arke-mods-export-worker
fly tokens create deploy --app arke-mods-export-worker

# Copy the token, then:
wrangler secret put FLY_API_TOKEN
# Paste the token when prompted
```

### 7. Deploy

```bash
npm run deploy
```

Or with wrangler directly:
```bash
wrangler deploy
```

You'll see output like:
```
Total Upload: XX.XX KiB / gzip: XX.XX KiB
Uploaded arke-export-orchestrator (X.XX sec)
Published arke-export-orchestrator (X.XX sec)
  https://arke-export-orchestrator.YOUR_SUBDOMAIN.workers.dev
Current Deployment ID: XXXXX
```

### 8. Test Deployment

```bash
# Test health endpoint
curl https://arke-export-orchestrator.YOUR_SUBDOMAIN.workers.dev/health

# Test export request
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

### 9. Set Up Custom Domain (Optional)

```bash
# Add custom domain
wrangler domains add orchestrator.arke.institute

# Update DNS with Cloudflare CNAME record
```

Then update the domain in your configuration.

## Monitoring & Maintenance

### View Logs

Stream live logs:
```bash
npm run tail
# or
wrangler tail
```

### Check KV Usage

```bash
wrangler kv:key list --namespace-id YOUR_KV_ID --preview false
```

### Check R2 Usage

```bash
wrangler r2 object list arke-exports
```

### Update Worker Image

When the export worker is updated:

```bash
# Get new deployment tag
fly image show --app arke-mods-export-worker

# Update wrangler.jsonc with new tag
# Then redeploy
npm run deploy
```

### Update Secrets

To rotate the Fly.io API token:

```bash
# Create new token
fly tokens create deploy --app arke-mods-export-worker

# Update secret
wrangler secret put FLY_API_TOKEN

# Redeploy
npm run deploy
```

## Environment-Specific Configuration

### Development (Local)

```bash
# Uses .dev.vars for secrets
# Uses preview KV and R2
npm run dev
```

### Staging (Optional)

Create `wrangler.staging.jsonc`:

```jsonc
{
  "name": "arke-export-orchestrator-staging",
  "kv_namespaces": [
    {
      "binding": "TASK_STORE",
      "id": "STAGING_KV_ID"
    }
  ],
  "r2_buckets": [
    {
      "binding": "R2_BUCKET",
      "bucket_name": "arke-exports-staging"
    }
  ]
}
```

Deploy to staging:
```bash
wrangler deploy --config wrangler.staging.jsonc
```

### Production

Use the main `wrangler.jsonc` configuration:

```bash
npm run deploy
```

## Troubleshooting

### "Namespace not found"

Make sure you've created the KV namespace and updated the ID in `wrangler.jsonc`.

### "R2 bucket not found"

Create the R2 bucket:
```bash
wrangler r2 bucket create arke-exports
```

### "Unauthorized" from Fly.io API

Check that your API token is valid:
```bash
# List secrets
wrangler secret list

# If FLY_API_TOKEN is missing or invalid, update it
wrangler secret put FLY_API_TOKEN
```

### Worker doesn't start

Check logs:
```bash
wrangler tail
```

Look for errors in the deployment output.

## Cost Estimation

### Cloudflare Workers

- **Free tier**: 100,000 requests/day
- **Paid**: $5/month for 10 million requests
- **KV**: ~$0.50/million reads, $5/million writes
- **R2**: $0.015/GB stored, free egress to Cloudflare

### Fly.io

- **Machines**: Billed per-second of runtime
- **Example**: 1024MB shared CPU, 60s runtime = ~$0.0001/export
- **Monthly estimate**: 10,000 exports ≈ $1

**Total estimated cost**: ~$10-20/month for moderate usage

## Rollback

If a deployment fails, rollback to previous version:

```bash
# List deployments
wrangler deployments list

# Rollback to specific deployment
wrangler rollback DEPLOYMENT_ID
```

## Next Steps

After deployment:

1. ✅ Test the health endpoint
2. ✅ Test an export request
3. ✅ Verify logs are streaming
4. ✅ Set up monitoring/alerts (optional)
5. ✅ Document the production URL for your team
6. ✅ Update client applications with the orchestrator URL

## Support

For issues:
- Check logs: `wrangler tail`
- Review Cloudflare dashboard
- Check Fly.io machine logs: `fly logs -a arke-mods-export-worker`
