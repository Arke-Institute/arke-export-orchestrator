# Arke Export Orchestrator

Cloudflare Worker that orchestrates MODS export jobs by spawning ephemeral Fly.io machines.

## Architecture

```
Client → Orchestrator (CF Worker) → Fly.io Machine (Export Worker)
   ↓
Status Polling (GET /status/:taskId)
   ↓
Fly Machine → Callback (POST /callback/:taskId) → Orchestrator
   ↓
Download (GET /download/:taskId) → R2 → Client
```

## Endpoints

### 1. Create Export Job

```bash
POST /export/mods

Request:
{
  "pi": "01K9Z3K4GMDWTT0VQXYSPC9W6S",
  "options": {
    "recursive": false,
    "maxDepth": 10,
    "parallelBatchSize": 10,
    "includeOcr": true,
    "cheimarrosMode": "full"
  }
}

Response:
{
  "task_id": "export_mods_1763061234567_a3f8c2d1",
  "status": "processing",
  "message": "Export job started. Use task_id to check status."
}
```

### 2. Check Status

```bash
GET /status/:taskId

Response:
{
  "task_id": "export_mods_1763061234567_a3f8c2d1",
  "status": "success",
  "pi": "01K9Z3K4GMDWTT0VQXYSPC9W6S",
  "created_at": 1763061234567,
  "completed_at": 1763061237891,
  "output_r2_key": "exports/export_mods_.../01K9Z3K4GMDWTT0VQXYSPC9W6S-collection.xml",
  "output_file_name": "01K9Z3K4GMDWTT0VQXYSPC9W6S-collection.xml",
  "output_file_size": 35885,
  "metrics": {
    "total_time_ms": 2934,
    "entities_exported": 72,
    "entities_failed": 0,
    "peak_memory_mb": 30
  }
}
```

### 3. Download Result

```bash
GET /download/:taskId

# Streams the MODS XML file directly
curl https://orchestrator.workers.dev/download/export_mods_1763061234567_a3f8c2d1 -o export.xml
```

### 4. Callback (Internal - called by Fly.io worker)

```bash
POST /callback/:taskId

Success:
{
  "task_id": "export_mods_abc123",
  "batch_id": "single",
  "status": "success",
  "output_r2_key": "exports/export_mods_abc123/01K9Z3K4GMDWTT0VQXYSPC9W6S-collection.xml",
  "output_file_name": "01K9Z3K4GMDWTT0VQXYSPC9W6S-collection.xml",
  "output_file_size": 35885,
  "metrics": { ... }
}

Error:
{
  "task_id": "export_mods_abc123",
  "batch_id": "single",
  "status": "error",
  "error": "Failed to fetch manifest: 404 Not Found"
}
```

## Development

### Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Create `.dev.vars` from `.dev.vars.example`:
   ```bash
   cp .dev.vars.example .dev.vars
   ```

4. Get Fly.io API token:
   ```bash
   fly tokens create deploy --app arke-mods-export-worker
   ```

5. Add token to `.dev.vars`:
   ```
   FLY_API_TOKEN="FlyV1 fm2_..."
   ```

### Local Development

```bash
npm run dev
```

This starts the worker at `http://localhost:8787`

### Test Export Request

```bash
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
```

### Check Status

```bash
curl http://localhost:8787/status/export_mods_1763061234567_a3f8c2d1
```

## Deployment

### Prerequisites

1. **Create KV namespace:**
   ```bash
   wrangler kv:namespace create TASK_STORE
   wrangler kv:namespace create TASK_STORE --preview
   ```

2. **Update `wrangler.jsonc`** with the KV namespace IDs

3. **Create R2 bucket:**
   ```bash
   wrangler r2 bucket create arke-exports
   ```

4. **Set secrets:**
   ```bash
   wrangler secret put FLY_API_TOKEN
   # Paste the token when prompted
   ```

### Deploy

```bash
npm run deploy
```

### View Logs

```bash
npm run tail
```

## Configuration

See `wrangler.jsonc` for configuration options:

- `FLY_APP_NAME` - Fly.io app name (arke-mods-export-worker)
- `FLY_REGION` - Fly.io region (ord - Chicago)
- `FLY_WORKER_IMAGE` - Docker image tag for export worker
- `WORKER_MEMORY_MB` - Memory allocation for machines (1024)
- `WORKER_CPUS` - CPU allocation for machines (2)

## Task State Storage

Tasks are stored in Cloudflare KV with TTL:
- **Processing tasks**: 1 hour expiration
- **Completed tasks**: 24 hour expiration

## R2 Key Structure

Export files are stored in R2 with this structure:

```
exports/
  {task_id}/
    {pi}-collection.xml
```

Example:
```
exports/export_mods_1763061234567_a3f8c2d1/01K9Z3K4GMDWTT0VQXYSPC9W6S-collection.xml
```

## Error Handling

- **400 Bad Request**: Missing required fields
- **404 Not Found**: Task not found
- **500 Internal Server Error**: Failed to spawn machine or other errors

## Future Enhancements

- [ ] Batch export support (multiple PIs in one request)
- [ ] Webhook notifications when export completes
- [ ] Automatic cleanup of R2 files after download/expiration
- [ ] Support for other export formats (DC, MARCXML, etc.)
- [ ] Rate limiting and authentication
- [ ] Retry logic for failed spawns
- [ ] Task timeout detection and cleanup

## License

MIT
