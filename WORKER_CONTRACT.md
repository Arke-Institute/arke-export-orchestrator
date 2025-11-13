# Worker Contract

This document defines the contract between the orchestrator and the export worker (Fly.io machine).

## Environment Variables Provided by Orchestrator

The orchestrator spawns Fly.io machines with these environment variables:

```typescript
{
  // Task identification
  TASK_ID: string;              // e.g., "export_mods_1763061234567_a3f8c2d1"
  PI: string;                   // e.g., "01K9Z3K4GMDWTT0VQXYSPC9W6S"
  EXPORT_FORMAT: string;        // Always "mods" for now
  BATCH_ID: string;             // "single" for single exports

  // Export options (JSON string)
  EXPORT_OPTIONS: string;       // e.g., "{\"recursive\":false,\"includeOcr\":true}"

  // Callback URL for results
  CALLBACK_URL: string;         // e.g., "https://orchestrator.workers.dev/callback/export_mods_..."
}
```

## R2 Credentials

**Important**: The orchestrator does NOT pass R2 credentials via environment variables.

Instead, the worker should have R2 credentials configured in its own environment (via Fly.io secrets or other means).

If the worker needs R2 access, it should:

### Option 1: Fly.io Secrets (Recommended)

```bash
# Set R2 credentials as Fly.io secrets
fly secrets set R2_ACCOUNT_ID="..." --app arke-mods-export-worker
fly secrets set R2_ACCESS_KEY_ID="..." --app arke-mods-export-worker
fly secrets set R2_SECRET_ACCESS_KEY="..." --app arke-mods-export-worker
fly secrets set R2_BUCKET="arke-exports" --app arke-mods-export-worker
```

### Option 2: Dockerfile ENV

Set them in the Dockerfile:

```dockerfile
ENV R2_ACCOUNT_ID=your_account_id
ENV R2_ACCESS_KEY_ID=your_access_key_id
ENV R2_SECRET_ACCESS_KEY=your_secret_access_key
ENV R2_BUCKET=arke-exports
```

### Option 3: Pass from Orchestrator (If Needed)

If you DO want the orchestrator to pass R2 credentials, uncomment this in `src/fly.ts`:

```typescript
// In spawnExportMachine():
env: {
  // ... existing vars ...

  // R2 credentials (if worker needs them)
  R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
  R2_BUCKET: 'arke-exports',
}
```

And add these to `src/types.ts` Env interface:

```typescript
export interface Env {
  // ... existing fields ...

  // R2 credentials (optional, if passing to worker)
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}
```

And add them to `wrangler.jsonc` secrets:

```bash
wrangler secret put R2_ACCOUNT_ID
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
```

## Worker Responsibilities

The export worker must:

1. **Read environment variables**
   - Parse `TASK_ID`, `PI`, `EXPORT_OPTIONS`
   - Use `CALLBACK_URL` for reporting results

2. **Perform the export**
   - Export the specified PI to MODS XML format
   - Apply options from `EXPORT_OPTIONS`

3. **Upload to R2**
   - Upload result to R2 bucket
   - Use key format: `exports/{TASK_ID}/{PI}-collection.xml`
   - The worker handles R2 upload with its own credentials

4. **Send callback on success**

```typescript
POST ${CALLBACK_URL}

{
  "task_id": "export_mods_abc123",
  "batch_id": "single",
  "status": "success",
  "output_r2_key": "exports/export_mods_abc123/01K9Z3K4GMDWTT0VQXYSPC9W6S-collection.xml",
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

5. **Send callback on error**

```typescript
POST ${CALLBACK_URL}

{
  "task_id": "export_mods_abc123",
  "batch_id": "single",
  "status": "error",
  "error": "Failed to fetch manifest for PI 01K9Z3K4GMDWTT0VQXYSPC9W6S: 404 Not Found"
}
```

6. **Exit**
   - Exit with code 0 on success
   - Exit with code 1 on error
   - The machine will auto-destroy on exit

## R2 Key Format

The worker should upload to:

```
exports/{TASK_ID}/{PI}-collection.xml
```

Example:
```
exports/export_mods_1763061234567_a3f8c2d1/01K9Z3K4GMDWTT0VQXYSPC9W6S-collection.xml
```

## Callback Requirements

- **URL**: Use the `CALLBACK_URL` environment variable
- **Method**: POST
- **Headers**: `Content-Type: application/json`
- **Body**: JSON with structure shown above
- **Timeout**: Should callback within 10 minutes (or export will be considered failed)
- **Retries**: Optional but recommended (orchestrator is idempotent)

## Export Options Schema

```typescript
interface ExportOptions {
  recursive?: boolean;              // Export child entities (default: false)
  maxDepth?: number;                // Max recursion depth (default: 10)
  parallelBatchSize?: number;       // Parallel processing batch size (default: 10)
  includeOcr?: boolean;             // Include OCR text (default: false)
  cheimarrosMode?: 'full' | 'minimal' | 'skip';  // Cheimarros metadata (default: 'skip')
}
```

## Example Worker Pseudocode

```typescript
// 1. Read environment
const taskId = process.env.TASK_ID!;
const pi = process.env.PI!;
const options = JSON.parse(process.env.EXPORT_OPTIONS || '{}');
const callbackUrl = process.env.CALLBACK_URL!;

// 2. Perform export
try {
  const startTime = Date.now();
  const xml = await exportToMods(pi, options);
  const totalTime = Date.now() - startTime;

  // 3. Upload to R2
  const r2Key = `exports/${taskId}/${pi}-collection.xml`;
  const fileSize = await uploadToR2(r2Key, xml);

  // 4. Send success callback
  await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task_id: taskId,
      batch_id: 'single',
      status: 'success',
      output_r2_key: r2Key,
      output_file_name: `${pi}-collection.xml`,
      output_file_size: fileSize,
      metrics: {
        total_time_ms: totalTime,
        entities_exported: 72,
        entities_failed: 0,
        peak_memory_mb: 30
      }
    })
  });

  // 5. Exit
  process.exit(0);

} catch (error) {
  // Send error callback
  await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task_id: taskId,
      batch_id: 'single',
      status: 'error',
      error: error.message
    })
  });

  process.exit(1);
}
```

## Summary

- ✅ Orchestrator provides: TASK_ID, PI, EXPORT_OPTIONS, CALLBACK_URL
- ✅ Worker handles: R2 credentials, export logic, upload, callback
- ✅ Worker uploads to: `exports/{TASK_ID}/{PI}-collection.xml`
- ✅ Worker callbacks to: CALLBACK_URL with success/error payload
- ✅ Machine auto-destroys on exit
