# Future: Batch Export Support

## Current Implementation

The orchestrator currently handles **single PI exports**:
- One PI per request
- `batch_id` is hardcoded to `"single"`
- Each request spawns one Fly.io machine

## Future: Batch Exports

To support batch exports (multiple PIs in one request), we would:

### 1. Accept Batch Requests

```typescript
POST /export/mods/batch

Request:
{
  "pis": [
    "01K9Z3K4GMDWTT0VQXYSPC9W6S",
    "01K9Z5X7GMDWTT0VQXYSPC9W7T",
    "01K9Z8K2GMDWTT0VQXYSPC9W8U"
  ],
  "options": {
    "recursive": false,
    "includeOcr": true
  }
}

Response:
{
  "batch_id": "batch_1763061234567_a3f8c2d1",
  "task_ids": [
    "export_mods_1763061234567_a3f8c2d1",
    "export_mods_1763061234568_b4g9c3e2",
    "export_mods_1763061234569_c5h0d4f3"
  ],
  "status": "processing",
  "message": "Batch export started with 3 tasks."
}
```

### 2. Spawn Multiple Machines

For each PI in the batch:
- Generate unique `task_id`
- Spawn separate Fly.io machine
- All tasks share the same `batch_id`

### 3. Track Batch Progress

```typescript
GET /status/batch/:batchId

Response:
{
  "batch_id": "batch_1763061234567_a3f8c2d1",
  "total_tasks": 3,
  "completed": 2,
  "failed": 0,
  "processing": 1,
  "tasks": [
    {
      "task_id": "export_mods_1763061234567_a3f8c2d1",
      "pi": "01K9Z3K4GMDWTT0VQXYSPC9W6S",
      "status": "success"
    },
    {
      "task_id": "export_mods_1763061234568_b4g9c3e2",
      "pi": "01K9Z5X7GMDWTT0VQXYSPC9W7T",
      "status": "success"
    },
    {
      "task_id": "export_mods_1763061234569_c5h0d4f3",
      "pi": "01K9Z8K2GMDWTT0VQXYSPC9W8U",
      "status": "processing"
    }
  ]
}
```

### 4. Download All Results

```typescript
GET /download/batch/:batchId

# Returns a ZIP file containing all successful exports
# Or individual downloads:
GET /download/:taskId
```

## Implementation Notes

### State Management

Store batch metadata in KV:
```typescript
interface BatchState {
  batch_id: string;
  task_ids: string[];
  total: number;
  completed: number;
  failed: number;
  created_at: number;
  completed_at?: number;
}
```

### Spawning Strategy

**Option 1: Spawn All at Once**
- Simple: spawn all machines immediately
- Risk: could hit Fly.io rate limits with large batches

**Option 2: Batched Spawning**
- Spawn in waves (e.g., 10 at a time)
- More reliable for large batches
- Requires queue or alarm-based scheduling

### Aggregation

**Option 1: Client-Side**
- Client downloads each task individually
- Simple orchestrator, more client work

**Option 2: Server-Side ZIP**
- Orchestrator fetches all R2 files
- Packages into ZIP
- Single download for client
- Requires streaming ZIP generation

### Current Code Ready for Batches?

The current implementation is **90% ready** for batch support:
- ✅ `batch_id` field exists in `TaskState`
- ✅ Callback handler supports any `batch_id`
- ✅ Each task is independent
- ❌ No batch-level state tracking
- ❌ No batch request endpoint
- ❌ No batch status endpoint

### When to Implement?

Implement batch support when:
1. Users need to export multiple PIs frequently
2. Current UI/UX makes single exports cumbersome
3. We have metrics showing demand for batch operations

For now, clients can make multiple single requests in parallel if needed.
