# Preprocessing Orchestrator Architecture

## Overview

The Arke Preprocessing Orchestrator is a Cloudflare Worker that manages batch preprocessing for the Arke Institute ingest pipeline. It orchestrates complex, multi-phase processing workflows by coordinating stateful Durable Objects with ephemeral Fly.io compute machines.

**Core Concept**: A single Cloudflare Worker that receives batch jobs via queue, delegates long-lived state management to SQLite-backed Durable Objects, and spawns short-lived Fly.io machines for resource-intensive compute tasks.

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────────┐
│                    PREPROCESS_QUEUE                              │
│                (Cloudflare Queue)                                │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  QUEUE CONSUMER                                  │
│            (src/index.ts:queue())                                │
│   • Receives batch messages                                      │
│   • Routes to appropriate Durable Object                         │
│   • Handles message ack/retry                                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│               DURABLE OBJECT                                     │
│          (src/batch-do.ts)                                       │
│   • One instance per batch_id (named DO)                         │
│   • SQLite-backed persistent state                               │
│   • Alarm-based scheduling                                       │
│   • Phase orchestration                                          │
└──────────┬────────────────────────┬─────────────────────────────┘
           │                        │
           ▼                        ▼
  ┌────────────────┐      ┌────────────────────┐
  │  Phase System  │      │   Fly.io Machines  │
  │   (src/phases) │      │  (Ephemeral)       │
  └────────────────┘      └────────────────────┘
           │                        │
           │◄───────────────────────┘
           │      (Callbacks)
           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  HTTP ENDPOINTS                                  │
│            (src/index.ts:fetch())                                │
│   • GET /status/:batchId  - Status polling                       │
│   • POST /callback/:batchId/:taskId - Fly callbacks              │
│   • POST /admin/reset/:batchId - Admin operations                │
└─────────────────────────────────────────────────────────────────┘
```

## Component Deep Dive

### 1. Queue Consumer (Entry Point)

**File**: `src/index.ts:queue()`

The queue consumer is the entry point for all batch processing jobs. It receives messages from the `arke-preprocess-jobs` Cloudflare Queue.

**Flow**:
1. Receive `MessageBatch` from Cloudflare Queue infrastructure
2. Extract `QueueMessage` from message body
3. Get or create Durable Object for `batch_id` using named ID strategy
4. Call `startBatch()` on DO stub
5. Acknowledge message on success, retry on failure

**Key Characteristics**:
- **Stateless**: No state persists between invocations
- **Idempotent**: Messages can be redelivered safely
- **Fast**: Minimal processing, delegates to DO immediately
- **Reliable**: Queue retries on failure (max 3 times before DLQ)

**Queue Configuration** (wrangler.jsonc):
```json
{
  "queue": "arke-preprocess-jobs",
  "max_batch_size": 1,
  "max_retries": 3,
  "dead_letter_queue": "preprocess-dlq"
}
```

**Message Format**:
```typescript
interface QueueMessage {
  batch_id: string;              // Unique batch identifier
  manifest_r2_key: string;       // R2 key to _manifest.json
  r2_prefix: string;             // Batch prefix in R2
  uploader: string;              // User who uploaded
  root_path: string;             // Logical root path
  parent_pi?: string;            // Parent permanent identifier
  total_files: number;           // File count
  total_bytes: number;           // Total size
  uploaded_at: string;           // ISO timestamp
  finalized_at: string;          // ISO timestamp
  metadata: Record<string, any>; // Additional metadata
}
```

**Why Manifest in R2?**
Queue messages reference manifests stored in R2 instead of embedding file lists directly. This avoids Cloudflare Queue's 128KB message size limit and allows batches to contain thousands of files.

### 2. Durable Objects (State Management)

**File**: `src/batch-do.ts`

Durable Objects are Cloudflare's stateful serverless primitives. Each batch gets its own Durable Object instance, providing:
- **Persistent state** backed by SQLite
- **Strong consistency** for all state operations
- **Automatic scaling** per batch
- **Alarm scheduling** for delayed execution

#### 2.1 Durable Object Lifecycle

```
┌──────────────┐
│ Queue Message│
└──────┬───────┘
       │
       ▼
┌─────────────────────────────────────────────┐
│ startBatch()                                 │
│  1. Check if batch exists (idempotency)      │
│  2. Fetch manifest from R2                   │
│  3. Initialize state                         │
│  4. Run first phase discovery                │
│  5. Save state to SQLite                     │
│  6. Schedule alarm (1s)                      │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│ alarm() - PHASE EXECUTION LOOP              │
│  1. Load state from SQLite                   │
│  2. Get current phase handler                │
│  3. Execute batch of tasks                   │
│  4. Update state                             │
│  5. If more work: schedule next alarm        │
│     Else: transition to next phase           │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│ handleCallback()                             │
│  1. Load state from SQLite                   │
│  2. Update task status                       │
│  3. If all tasks done: transition phase      │
│     Else: save state and continue            │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│ transitionToNextPhase()                      │
│  1. Apply phase transformations to files     │
│  2. Get next phase (or null for DONE)        │
│  3. Discover tasks in next phase             │
│  4. Update state with new phase              │
│  5. If tasks exist: schedule alarm           │
│     Else if no more phases: finalize         │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│ finalizeBatch()                              │
│  1. Mark status as DONE                      │
│  2. Build final file list                    │
│  3. Callback to ingest worker                │
│  4. Clear alarm                              │
└─────────────────────────────────────────────┘
```

#### 2.2 SQLite Storage Backend

**Migration Configuration** (wrangler.jsonc):
```json
"migrations": [
  {
    "tag": "v1-reset-2025-01",
    "new_sqlite_classes": ["PreprocessingDurableObject"]
  }
]
```

**Storage Operations**:
```typescript
// Write state
await this.ctx.storage.put('state', batchState);

// Read state
const state = await this.ctx.storage.get<BatchState>('state');

// Alarms
await this.ctx.storage.setAlarm(Date.now() + delay);
await this.ctx.storage.deleteAlarm();
```

**BatchState Structure**:
```typescript
interface BatchState {
  // Identity
  batch_id: string;
  status: BatchStatus;  // TIFF_CONVERSION | IMAGE_PROCESSING | DONE | ERROR

  // Original queue message (preserved for reference)
  queue_message: QueueMessage;

  // Current file list (evolves through phases)
  current_file_list: ProcessableFile[];

  // Current phase tasks
  current_phase_tasks: Record<string, Task>;

  // Progress counters
  tasks_total: number;
  tasks_completed: number;
  tasks_failed: number;

  // Metadata
  started_at: string;
  updated_at: string;
  completed_at?: string;
  error?: string;

  // Retry tracking
  phase_retry_count: number;
}
```

**Why SQLite?**
- **Persistence**: Survives Worker restarts/evictions
- **Consistency**: ACID guarantees for state updates
- **Performance**: Optimized for Cloudflare's infrastructure
- **Capacity**: Handles complex state (manifests, tasks, files)

#### 2.3 Alarm-Based Scheduling

Alarms are Cloudflare's mechanism for scheduled execution. They provide:
- **Guaranteed execution** after specified delay
- **Persistence** across Worker restarts
- **Exactly-once semantics** per alarm fire

**Alarm Flow**:
```
startBatch() ──► Schedule alarm (1s delay)
                        │
                        ▼
                 alarm() fires
                        │
                        ▼
              Execute phase batch
                        │
                        ├──► More work? Schedule next alarm (5s delay)
                        │
                        └──► Phase complete? Transition to next phase
```

**Alarm Delays** (configurable):
- Initial alarm: 1000ms (1 second)
- Processing alarms: 5000ms (5 seconds, configurable per phase)
- Error retry: Exponential backoff up to 30000ms (30 seconds)

**Why Alarms?**
- **Cost-effective**: No polling, only runs when needed
- **Scalable**: Each DO manages its own schedule
- **Fault-tolerant**: Alarms persist through failures
- **Rate-limiting**: Natural backpressure via alarm delays

### 3. Phase System (Processing Orchestration)

**Directory**: `src/phases/`

The phase system is the core abstraction for preprocessing workflows. Each phase is self-contained and implements the `Phase` interface.

#### 3.1 Phase Interface

**File**: `src/phases/base.ts`

```typescript
interface Phase {
  name: BatchStatus;

  // Discover tasks from current file list
  discover(files: ProcessableFile[]): Promise<Task[]>;

  // Execute a batch of tasks (spawn Fly machines)
  executeBatch(state: BatchState, config: Config, env: Env): Promise<boolean>;

  // Handle callback from Fly worker
  handleCallback(task: Task, result: any, state: BatchState): void;

  // Get next phase after this one completes
  getNextPhase(): BatchStatus | null;

  // Transform files after phase completes
  transformFile(file: ProcessableFile, task: Task | undefined): ProcessableFile[];
}
```

**Phase Responsibilities**:
1. **Discovery**: Analyze file list and identify work
2. **Execution**: Spawn Fly machines for compute tasks
3. **Callback Handling**: Process results from Fly workers
4. **Transformation**: Define how files evolve after processing
5. **Ordering**: Specify next phase in pipeline

#### 3.2 Phase Chaining & File Transformations

Phases build on each other's outputs through the `current_file_list` that evolves through the pipeline:

```
Initial Files → Phase 1 → Transform → Phase 2 → Transform → Final Files
  (from R2)    (discover)   (modify)  (discover)   (modify)   (to worker)
```

**Example: TIFF → IMAGE Pipeline**:

```
Initial:
  [
    {file: "photo.tiff", type: "image/tiff"},
    {file: "doc.pdf", type: "application/pdf"}
  ]
         │
         ▼
TIFF_CONVERSION Phase:
  • discover(): Finds photo.tiff
  • executeBatch(): Spawns Fly machine to convert to JPEG
  • handleCallback(): Receives converted JPEG info
  • transformFile(): Returns BOTH files:
         │
         ▼
After TIFF Phase:
  [
    {file: "photo.tiff", type: "image/tiff", tags: ["TiffConverter:source"]},
    {file: "photo.jpg", type: "image/jpeg", tags: ["TiffConverter"]},
    {file: "doc.pdf", type: "application/pdf"}
  ]
         │
         ▼
IMAGE_PROCESSING Phase:
  • discover(): Finds photo.jpg (skips TiffConverter:source)
  • executeBatch(): Spawns Fly machine to resize, upload CDN, archive
  • handleCallback(): Receives CDN URL and ref data
  • transformFile(): Replaces photo.jpg with photo.jpg.ref.json
         │
         ▼
Final:
  [
    {file: "photo.tiff", type: "image/tiff", tags: ["TiffConverter:source"]},
    {file: "photo.jpg.ref.json", type: "application/json", tags: ["ImageProcessor"]},
    {file: "doc.pdf", type: "application/pdf"}
  ]
         │
         ▼
  Sent to ingest worker
```

**Transform Patterns**:
- **Preserve**: Return original file unchanged
- **Replace**: Return different file(s) instead of original
- **Augment**: Return original plus additional files
- **Remove**: Return empty array (rare)

#### 3.3 Current Phases

##### Phase 1: TIFF Conversion

**File**: `src/phases/tiff-conversion.ts`

**Purpose**: Convert TIFF files to JPEG for downstream processing

**Discovery**:
```typescript
discover(files: ProcessableFile[]): Promise<TiffConversionTask[]> {
  // Find files matching *.tiff or *.tif
  return files
    .filter(f => /\.tiff?$/i.test(f.file_name))
    .map(f => createTiffTask(f));
}
```

**Execution**:
- Spawns Fly.io machines in `FLY_TIFF_APP_NAME` app
- Batch size: configurable (default 1000)
- Machine specs: 1024MB RAM, 2 CPUs (shared)
- Timeout: 60 seconds (configurable)

**Fly Machine Config**:
```typescript
{
  image: "registry.fly.io/arke-tiff-worker:v1.0.0",
  env: {
    TASK_ID: "tiff_abc123",
    BATCH_ID: "batch-123",
    INPUT_R2_KEY: "staging/batch-123/photo.tiff",
    R2_ACCOUNT_ID: "...",
    R2_ACCESS_KEY_ID: "...",
    R2_SECRET_ACCESS_KEY: "...",
    R2_BUCKET: "arke-staging",
    CALLBACK_URL: "https://orchestrator/callback/batch-123/tiff_abc123"
  },
  auto_destroy: true,
  guest: {
    memory_mb: 1024,
    cpus: 2,
    cpu_kind: "shared"
  }
}
```

**Callback Handling**:
```typescript
handleCallback(task: TiffConversionTask, result: TiffCallbackResult) {
  if (result.status === 'success') {
    task.status = 'completed';
    task.output_r2_key = result.output_r2_key;
    task.output_file_size = result.output_file_size;
  } else {
    task.status = 'failed';
    task.error = result.error;
  }
}
```

**File Transformation**:
```typescript
transformFile(file: ProcessableFile, task?: TiffConversionTask): ProcessableFile[] {
  if (task?.status === 'completed') {
    return [
      // Original TIFF (preserved for archive)
      {...file, preprocessor_tags: ['TiffConverter:source']},
      // Converted JPEG (for further processing)
      {
        r2_key: task.output_r2_key,
        file_name: task.output_file_name,
        content_type: 'image/jpeg',
        preprocessor_tags: ['TiffConverter']
      }
    ];
  }
  return [file]; // Unchanged if not converted
}
```

**Next Phase**: `IMAGE_PROCESSING`

##### Phase 2: Image Processing

**File**: `src/phases/image-processing.ts`

**Purpose**:
- Resize images into smart variants (thumbnail, medium, large)
- Upload variants to CDN
- Archive originals to cold storage
- Create `.ref.json` files pointing to CDN

**Discovery**:
```typescript
discover(files: ProcessableFile[]): Promise<ImageProcessingTask[]> {
  return files
    .filter(f => ['image/jpeg', 'image/png', 'image/webp'].includes(f.content_type))
    .filter(f => !f.preprocessor_tags?.includes('TiffConverter:source'))
    .map(f => createImageTask(f));
}
```

**Why Skip TiffConverter:source?**
We only want to process the converted JPEGs, not the original TIFFs (which are preserved for archival).

**Execution**:
- Spawns Fly.io machines in `FLY_IMAGE_APP_NAME` app
- Batch size: configurable (default 1000)
- Machine specs: 2048MB RAM, 2 CPUs (more memory for image processing)
- Timeout: 120 seconds (configurable, longer for CDN uploads)

**Callback Handling**:
```typescript
handleCallback(task: ImageProcessingTask, result: ImageCallbackResult) {
  if (result.status === 'success') {
    task.status = 'completed';
    task.ref_json_r2_key = result.ref_json_r2_key;
    task.ref_data = result.ref_data;  // CDN URLs, metadata
    task.archive_r2_key = result.archive_r2_key;
  } else {
    task.status = 'failed';
    task.error = result.error;
  }
}
```

**File Transformation**:
```typescript
transformFile(file: ProcessableFile, task?: ImageProcessingTask): ProcessableFile[] {
  if (task?.status === 'completed') {
    // REPLACE original image with .ref.json
    return [{
      r2_key: task.ref_json_r2_key,
      file_name: file.file_name + '.ref.json',
      content_type: 'application/json',
      preprocessor_tags: ['ImageProcessor']
    }];
  }
  return [file]; // Keep original if processing failed
}
```

**RefData Structure**:
```typescript
interface RefData {
  url: string;         // CDN URL (https://cdn.arke.institute/...)
  ipfs_cid?: string;   // Original IPFS CID if available
  type?: string;       // MIME type
  size?: number;       // File size
  filename?: string;   // Original filename
}
```

**Next Phase**: `null` (goes to DONE)

#### 3.4 Adding New Phases

To add a new phase (e.g., PDF OCR):

1. **Create phase class**:
```typescript
// src/phases/pdf-ocr.ts
export class PdfOcrPhase implements Phase {
  name: BatchStatus = 'PDF_OCR';

  async discover(files: ProcessableFile[]): Promise<PdfOcrTask[]> {
    return files
      .filter(f => f.content_type === 'application/pdf')
      .map(f => createPdfOcrTask(f));
  }

  async executeBatch(state, config, env): Promise<boolean> {
    // Spawn Fly machines for OCR
  }

  handleCallback(task, result, state): void {
    // Process OCR results
  }

  getNextPhase(): BatchStatus | null {
    return null; // or next phase
  }

  transformFile(file, task): ProcessableFile[] {
    // Add OCR text as metadata
  }
}
```

2. **Update BatchStatus enum**:
```typescript
// src/types/state.ts
export type BatchStatus =
  | 'TIFF_CONVERSION'
  | 'IMAGE_PROCESSING'
  | 'PDF_OCR'  // Add new status
  | 'DONE'
  | 'ERROR';
```

3. **Register phase**:
```typescript
// src/batch-do.ts
private phases: Map<BatchStatus, Phase> = new Map([
  ['TIFF_CONVERSION', new TiffConversionPhase()],
  ['IMAGE_PROCESSING', new ImageProcessingPhase()],
  ['PDF_OCR', new PdfOcrPhase()],  // Add new phase
]);
```

4. **Update phase ordering**:
```typescript
// In previous phase's getNextPhase()
getNextPhase(): BatchStatus | null {
  return 'PDF_OCR';  // Route to new phase
}
```

### 4. Fly.io Machine Spawning

**Pattern**: Ephemeral compute for resource-intensive tasks

#### 4.1 Why Fly.io?

**Cloudflare Workers Limitations**:
- 128MB memory limit
- 30 second CPU time limit
- No native image processing libraries
- No GPU access

**Fly.io Advantages**:
- Up to 8GB memory per machine
- No CPU time limits
- Full Docker container support (native libraries)
- GPU instances available
- Machines API for programmatic spawning

#### 4.2 Machine Lifecycle

```
Orchestrator DO ──► Fly Machines API ──► Machine created
                         │
                         ▼
                    Pull Docker image
                         │
                         ▼
                    Start container
                         │
                         ▼
              Run processing (download → process → upload)
                         │
                         ▼
              POST callback to orchestrator
                         │
                         ▼
                 auto_destroy: true
                         │
                         ▼
              Machine destroyed automatically
```

**Key Properties**:
- **Ephemeral**: Created for single task, auto-destroyed after completion
- **Stateless**: All state passed via environment variables
- **Isolated**: Each task gets its own machine
- **Scalable**: Spawn thousands in parallel

#### 4.3 Machine Configuration

**Authentication**:
```typescript
headers: {
  'Authorization': `Bearer ${env.FLY_API_TOKEN}`
}
```

**Spawn Endpoint**:
```
POST https://api.machines.dev/v1/apps/{app_name}/machines
```

**Request Body**:
```typescript
{
  name: "tiff-abc123",  // Unique machine name
  config: {
    image: "registry.fly.io/arke-tiff-worker:v1.0.0",
    env: {
      // Task-specific data
      TASK_ID: "tiff_abc123",
      BATCH_ID: "batch-123",
      INPUT_R2_KEY: "staging/batch-123/photo.tiff",

      // R2 credentials (passed through)
      R2_ACCOUNT_ID: "...",
      R2_ACCESS_KEY_ID: "...",
      R2_SECRET_ACCESS_KEY: "...",
      R2_BUCKET: "arke-staging",

      // Callback URL for results
      CALLBACK_URL: "https://orchestrator/callback/batch-123/tiff_abc123"
    },

    // Machine behavior
    auto_destroy: true,          // Destroy after exit
    restart: { policy: "no" },   // Don't restart on failure

    // Resource allocation
    guest: {
      memory_mb: 1024,
      cpus: 2,
      cpu_kind: "shared"
    }
  },

  // Geographic placement
  region: "ord"
}
```

**Response**:
```typescript
{
  id: "148ed23e717308",  // Machine ID
  name: "tiff-abc123",
  state: "starting",
  // ... other fields
}
```

#### 4.4 Callback Protocol

**Flow**:
```
Fly Machine ──► Process file
       │
       ▼
  POST /callback/:batchId/:taskId
       │
       ▼
Orchestrator receives callback
       │
       ▼
Route to correct DO by batchId
       │
       ▼
DO updates task status
       │
       ▼
Check if all tasks complete
       │
       ├──► More tasks? Continue
       │
       └──► All done? Transition phase
```

**Callback Body** (TIFF example):
```typescript
{
  task_id: "tiff_abc123",
  batch_id: "batch-123",
  status: "success",

  // Output files
  output_r2_key: "staging/batch-123/photo.jpg",
  output_file_name: "photo.jpg",
  output_file_size: 245678,

  // Performance metrics
  performance: {
    total_time_ms: 3400,
    download_time_ms: 800,
    conversion_time_ms: 2100,
    upload_time_ms: 500
  }
}
```

**Error Handling**:
```typescript
{
  task_id: "tiff_abc123",
  batch_id: "batch-123",
  status: "error",
  error: "Failed to decode TIFF: corrupt data at byte 12345"
}
```

#### 4.5 Timeout Management

Tasks can timeout if Fly machine hangs or fails to callback:

```typescript
private checkTimeouts(state: BatchState, timeoutMs: number): void {
  const now = Date.now();

  for (const task of Object.values(state.current_phase_tasks)) {
    if (task.status === 'processing' && task.started_at) {
      const elapsed = now - new Date(task.started_at).getTime();

      if (elapsed > timeoutMs) {
        task.status = 'failed';
        task.error = `Task timed out after ${elapsed/1000}s`;
        state.tasks_failed++;
      }
    }
  }
}
```

**Timeout Behavior**:
- Called at start of each `executeBatch()`
- Marks stalled tasks as failed
- Continues processing remaining tasks
- Timeout doesn't fail entire batch

### 5. HTTP Endpoints

**File**: `src/index.ts:fetch()`

#### 5.1 Status Polling

**Endpoint**: `GET /status/:batchId`

**Purpose**: Allow external systems (ingest worker UI, monitoring) to poll batch progress

**Flow**:
```
Client ──► GET /status/batch-123
             │
             ▼
      Get DO for batch-123
             │
             ▼
      DO.fetch(/status)
             │
             ▼
      DO.getStatus()
             │
             ▼
      Return StatusResponse
```

**Response**:
```typescript
{
  batch_id: "batch-123",
  status: "IMAGE_PROCESSING",
  progress: {
    tasks_total: 150,
    tasks_completed: 98,
    tasks_failed: 2
  },
  started_at: "2025-01-13T10:30:00Z",
  updated_at: "2025-01-13T10:35:23Z"
}
```

**States**:
- `TIFF_CONVERSION`: Converting TIFFs
- `IMAGE_PROCESSING`: Processing images
- `DONE`: All processing complete
- `ERROR`: Terminal failure

#### 5.2 Callback Endpoint

**Endpoint**: `POST /callback/:batchId/:taskId`

**Purpose**: Receive results from Fly.io machines

**Flow**:
```
Fly Machine ──► POST /callback/batch-123/tiff_abc123
                     │
                     ▼
               Extract batchId & taskId
                     │
                     ▼
               Get DO for batchId
                     │
                     ▼
               DO.handleCallback(taskId, result)
                     │
                     ▼
               Update task status
                     │
                     ▼
               Check if phase complete
                     │
                     ├──► All done? Transition
                     │
                     └──► More work? Save state
```

**Security Considerations**:
- No authentication (Fly machines are ephemeral, URLs are unpredictable)
- Could add HMAC signatures for production
- Rate limiting via Cloudflare

#### 5.3 Admin Endpoints

**Endpoint**: `POST /admin/reset/:batchId`

**Purpose**: Manually reset stuck batches to ERROR state

**Use Cases**:
- Debugging
- Force cleanup of stuck DOs
- Cancel long-running batches

**Implementation**:
```typescript
async reset(): Promise<void> {
  await this.ctx.storage.deleteAlarm();

  const state = await this.ctx.storage.get<BatchState>('state');
  if (state) {
    state.status = 'ERROR';
    state.error = 'Manually reset by admin';
    await this.ctx.storage.put('state', state);
  }
}
```

## State Management Deep Dive

### Queue Message vs Manifest vs Current File List

**Three File Representations**:

1. **Queue Message** (`queue_message`):
   - Original message from ingest worker
   - Contains `manifest_r2_key` pointer
   - Preserved for reference, never modified
   - Used for debugging, audit trail

2. **Manifest** (fetched from R2):
   - Complete file list at batch start
   - Organized by directory groups
   - Includes processing configs per directory
   - Loaded once in `startBatch()`

3. **Current File List** (`current_file_list`):
   - Evolving file list through phases
   - Modified by each phase's `transformFile()`
   - Represents current state of batch
   - Final version sent to ingest worker

**Evolution Example**:
```
Queue Message:
  manifest_r2_key: "staging/batch-123/_manifest.json"
         │
         ▼
Manifest (from R2):
  files: [
    {r2_key: "photo.tiff", ...},
    {r2_key: "doc.pdf", ...}
  ]
         │
         ▼
Initial current_file_list:
  [{r2_key: "photo.tiff", ...},
   {r2_key: "doc.pdf", ...}]
         │
         ▼ (TIFF phase)
After TIFF current_file_list:
  [{r2_key: "photo.tiff", tags: ["TiffConverter:source"]},
   {r2_key: "photo.jpg", tags: ["TiffConverter"]},
   {r2_key: "doc.pdf", ...}]
         │
         ▼ (IMAGE phase)
Final current_file_list:
  [{r2_key: "photo.tiff", tags: ["TiffConverter:source"]},
   {r2_key: "photo.jpg.ref.json", tags: ["ImageProcessor"]},
   {r2_key: "doc.pdf", ...}]
         │
         ▼
Sent to ingest worker
```

### Task Lifecycle

**Task States**:
- `pending`: Discovered, not yet spawned
- `processing`: Fly machine spawned, waiting for callback
- `completed`: Callback received, task succeeded
- `failed`: Callback received with error, or timeout

**Task Flow**:
```
discover() ──► Create task (pending)
                    │
                    ▼
         Save to current_phase_tasks
                    │
                    ▼
executeBatch() ──► Spawn Fly machine
                    │
                    ▼
              Update to processing
                    │
                    ▼
handleCallback() ──► Update to completed/failed
                    │
                    ▼
              Check if all tasks done
                    │
                    ├──► More tasks? Continue
                    │
                    └──► All done? Transform & transition
```

**Task Progress Tracking**:
```typescript
interface BatchState {
  tasks_total: number;       // Total tasks in current phase
  tasks_completed: number;   // Successfully completed
  tasks_failed: number;      // Failed (errors or timeouts)

  // Calculated: tasks_remaining = tasks_total - (tasks_completed + tasks_failed)
}
```

### Error Handling & Retries

#### Phase-Level Retries

**When**: Entire phase execution fails (Fly API errors, network issues)

**Strategy**: Exponential backoff up to max attempts

```typescript
private async handleError(error: any): Promise<void> {
  this.state!.phase_retry_count++;

  if (this.state!.phase_retry_count >= config.MAX_RETRY_ATTEMPTS) {
    // Give up - mark batch as ERROR
    this.state!.status = 'ERROR';
    this.state!.error = `Failed after ${this.state!.phase_retry_count} retries`;
    await this.ctx.storage.deleteAlarm();
    await this.saveState();
  } else {
    // Retry with exponential backoff
    const delay = Math.min(
      config.ALARM_DELAY_ERROR_RETRY,  // Max delay (30s)
      1000 * Math.pow(2, this.state!.phase_retry_count)  // 2s, 4s, 8s, 16s...
    );

    await this.saveState();
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }
}
```

**Backoff Schedule**:
- Attempt 1: 2 seconds
- Attempt 2: 4 seconds
- Attempt 3: 8 seconds
- Attempt 4: 16 seconds
- Attempt 5: 30 seconds (capped)
- After 5 attempts: ERROR state

#### Task-Level Failures

**When**: Individual task fails (Fly worker error, timeout)

**Strategy**: Mark task as failed, continue with other tasks

```typescript
handleCallback(task, result, state) {
  if (result.status === 'error') {
    task.status = 'failed';
    task.error = result.error;
    state.tasks_failed++;
    // Continue processing other tasks
  }
}
```

**Batch Behavior**:
- Failed tasks don't fail entire batch
- Files with failed tasks pass through unchanged
- Final callback includes both successful and failed files

#### Queue-Level Retries

**When**: Queue consumer fails to route to DO

**Strategy**: Queue infrastructure automatically retries

**Configuration**:
```json
{
  "max_retries": 3,
  "dead_letter_queue": "preprocess-dlq"
}
```

**Flow**:
```
Attempt 1 ──► Fail (DO unreachable)
                │
                ▼
Attempt 2 ──► Fail (DO timeout)
                │
                ▼
Attempt 3 ──► Fail (persistent error)
                │
                ▼
         Move to DLQ
```

## Performance Characteristics

### Scalability

**Horizontal Scaling**:
- Each batch gets own DO instance
- DOs scale automatically per batch
- Fly machines spawn in parallel (up to batch size limit)

**Limits**:
- Batch size: 1000 machines per alarm (configurable)
- Alarm delay: 5 seconds between batches (configurable)
- Throughput: ~12,000 tasks/minute per phase (1000 tasks / 5s)

**Example: 10,000 File Batch**:
```
TIFF Phase (500 TIFFs):
  Batch 1: 500 machines spawned ────► 60s processing
                                            │
Final callback received ◄────────────────────┘
  Transition: 100ms

IMAGE Phase (500 JPEGs + 9,500 passthrough):
  Batch 1: 500 machines spawned ────► 120s processing
                                            │
Final callback received ◄────────────────────┘

Total: ~3 minutes for 10,000 file batch
```

### Cost Optimization

**Cloudflare Costs**:
- Queue: $0.40 per million messages
- DO storage: $0.20 per GB-month
- DO compute: $12.50 per million requests
- Worker invocations: First 100K/day free

**Fly.io Costs**:
- Billed per-second of machine runtime
- Auto-destroy minimizes idle time
- Shared CPU instances for cost efficiency

**Optimization Strategies**:
1. Batch task spawning (avoid spawning one-at-a-time)
2. Alarm-based scheduling (avoid polling)
3. Ephemeral machines (auto_destroy)
4. Smart phase ordering (fail fast on errors)

### Monitoring & Observability

**Logging**:
```typescript
console.log(`[DO] Starting batch ${batchId}`);
console.log(`[TiffConversion] Spawned machine ${machineId}`);
console.log(`[ImageProcessing] ✓ Task ${taskId} completed`);
console.error(`[DO] ✗ Failed to spawn machine: ${error}`);
```

**Log Streaming**:
```bash
npm run tail  # Stream logs from deployed worker
```

**Metrics to Track**:
- Batch duration (started_at → completed_at)
- Task success/failure rates
- Phase retry counts
- Fly machine spawn failures
- Callback latency

**Status Polling**:
```typescript
// External systems can poll progress
GET /status/:batchId

// Response includes:
{
  progress: {
    tasks_total: 100,
    tasks_completed: 87,
    tasks_failed: 3
  }
}
```

## Configuration Reference

### Environment Variables

**Required Secrets** (set via `wrangler secret put`):
```bash
FLY_API_TOKEN              # Fly.io API authentication
R2_ACCOUNT_ID              # Cloudflare R2 account
R2_ACCESS_KEY_ID           # R2 access key
R2_SECRET_ACCESS_KEY       # R2 secret key
```

**Config Variables** (in `wrangler.jsonc`):
```javascript
{
  // Fly.io - TIFF conversion
  FLY_TIFF_APP_NAME: "arke-tiff-worker",
  FLY_TIFF_WORKER_IMAGE: "registry.fly.io/arke-tiff-worker:v1.0.0",

  // Fly.io - Image processing
  FLY_IMAGE_APP_NAME: "arke-image-processor",
  FLY_IMAGE_WORKER_IMAGE: "registry.fly.io/arke-image-processor:latest",

  FLY_REGION: "ord",  // Chicago region

  // URLs
  ORCHESTRATOR_URL: "https://preprocessing-orchestrator.arke.institute",
  WORKER_URL: "https://ingest.arke.institute",
  CDN_PUBLIC_URL: "https://cdn.arke.institute",
  CDN_API_URL: "https://cdn.arke.institute",

  // Buckets
  R2_BUCKET: "arke-staging",
  ARCHIVE_BUCKET: "arke-archive",

  // Batch sizes (max machines per alarm)
  BATCH_SIZE_TIFF_CONVERSION: "1000",
  BATCH_SIZE_IMAGE_PROCESSING: "1000",

  // Alarm delays (milliseconds)
  ALARM_DELAY_TIFF_CONVERSION: "5000",
  ALARM_DELAY_IMAGE_PROCESSING: "5000",
  ALARM_DELAY_ERROR_RETRY: "30000",

  // Task timeouts (milliseconds)
  TASK_TIMEOUT_TIFF_CONVERSION: "60000",    // 1 minute
  TASK_TIMEOUT_IMAGE_PROCESSING: "120000",  // 2 minutes

  // Retry limits
  MAX_RETRY_ATTEMPTS: "5"
}
```

### Tuning Guidelines

**Batch Sizes**:
- **Too small**: Underutilizes parallel processing, slower overall
- **Too large**: May hit Fly.io rate limits, harder to debug
- **Sweet spot**: 100-1000 depending on task duration

**Alarm Delays**:
- **Too short**: Wastes DO invocations checking for completions
- **Too long**: Adds unnecessary latency between batches
- **Sweet spot**: 5-10 seconds for most workloads

**Task Timeouts**:
- **Too short**: Tasks fail before completing legitimately slow work
- **Too long**: Stuck tasks waste resources and delay completion
- **Sweet spot**: 2-3x expected task duration

## Troubleshooting

### Common Issues

**Batch Stuck in Processing**:
```bash
# Check status
curl https://orchestrator/status/batch-123

# If stuck, manually reset
curl -X POST https://orchestrator/admin/reset/batch-123

# Check logs
wrangler tail
```

**Manifest Not Found**:
```
Error: Manifest not found in R2: staging/batch-123/_manifest.json
```
**Fix**: Ensure ingest worker uploaded manifest before sending queue message

**Fly Machine Spawn Failures**:
```
Error: Fly API error: 429 Too Many Requests
```
**Fix**: Reduce `BATCH_SIZE_*` or increase `ALARM_DELAY_*`

**Tasks Timing Out**:
```
Warning: Task timed out after 65s
```
**Fix**: Increase `TASK_TIMEOUT_*` or investigate Fly worker performance

### Debugging Checklist

1. **Check Queue**:
   - Verify messages being delivered
   - Check DLQ for failed messages

2. **Check DO State**:
   - Poll `/status/:batchId`
   - Look for error messages

3. **Check Fly Machines**:
   - `fly machines list -a arke-tiff-worker`
   - Look for stuck machines

4. **Check Logs**:
   - `wrangler tail` for Worker logs
   - `fly logs -a arke-tiff-worker` for Fly logs

5. **Check R2**:
   - Verify manifest exists
   - Verify input files exist
   - Check output files created

## Future Enhancements

### Potential Improvements

1. **Webhooks**: Allow external systems to subscribe to batch events
2. **Priority Queues**: Fast-track urgent batches
3. **Partial Retries**: Retry only failed tasks instead of entire phase
4. **Metrics Dashboard**: Real-time visualization of processing
5. **Cost Tracking**: Per-batch cost attribution
6. **Smart Batching**: Dynamic batch sizes based on task duration
7. **Machine Pooling**: Reuse machines across tasks (trade-off: complexity vs cost)

### Architecture Evolution

**Current**: Queue → DO → Fly → Callback
**Future**: Queue → DO → (Fly | GPU | Specialized) → Callback

Support multiple compute backends:
- Fly.io for general compute
- GPU instances for ML workloads
- Specialized APIs (OpenAI, Anthropic) for LLM tasks
- Cloudflare R2 direct operations for simple transformations

## Conclusion

The Arke Preprocessing Orchestrator demonstrates a powerful pattern for building scalable, fault-tolerant batch processing systems on serverless infrastructure:

1. **Stateless entry point** (Queue Consumer) for high throughput
2. **Stateful orchestration** (Durable Objects + SQLite) for reliability
3. **Ephemeral compute** (Fly.io Machines) for resource-intensive tasks
4. **Phase-based architecture** for composable workflows
5. **Alarm-based scheduling** for cost-effective execution

This architecture handles thousands of files per batch, supports complex multi-phase pipelines, and provides strong fault tolerance while remaining cost-effective and maintainable.
