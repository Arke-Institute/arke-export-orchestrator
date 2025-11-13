 Orchestrator Contract Specification

  What the Orchestrator Must Do

  1. Receive Export Request

  The orchestrator receives an HTTP request from the client:

  // Example client request to orchestrator
  POST https://orchestrator.workers.dev/export/mods

  Request Body:
  {
    "pi": "01K9XVBAQZF9EHDRXGBEADTZYY",
    "options": {
      "recursive": true,
      "maxDepth": 10,
      "parallelBatchSize": 10,
      "includeOcr": true,
      "cheimarrosMode": "full"
    }
  }

  Response (immediate):
  {
    "task_id": "export_mods_abc123",
    "status": "processing",
    "message": "Export job started. Use task_id to check status."
  }

  2. Generate Unique Task ID

  const taskId = `export_mods_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  // Example: "export_mods_1704857234567_a3f8c2d1"

  3. Spawn Fly.io Ephemeral Machine

  const flyResponse = await fetch(
    `https://api.machines.dev/v1/apps/arke-mods-export-worker/machines`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.FLY_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        config: {
          image: 'registry.fly.io/arke-mods-export-worker:latest',
          env: {
            // Required
            TASK_ID: taskId,
            PI: requestBody.pi,
            EXPORT_FORMAT: 'mods',

            // Export options as JSON string
            EXPORT_OPTIONS: JSON.stringify(requestBody.options),

            // R2 credentials (from Cloudflare env vars)
            R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
            R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
            R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
            R2_BUCKET: 'arke-exports',

            // Callback URL for worker to report back
            CALLBACK_URL: `https://orchestrator.workers.dev/callback/${taskId}`,

            // Optional: batch tracking
            BATCH_ID: batchId || 'single',
          },
          auto_destroy: true,  // Machine destroys after exit
          restart: { policy: 'no' },  // Don't restart on failure
        },
        region: 'ord',  // Chicago
      }),
    }
  );

  4. Store Task State

  // Store in KV or Durable Object
  await env.TASK_STORE.put(taskId, JSON.stringify({
    status: 'processing',
    pi: requestBody.pi,
    options: requestBody.options,
    createdAt: Date.now(),
    machineId: flyResponse.id,
  }), {
    expirationTtl: 3600, // 1 hour expiration
  });

  5. Implement Callback Endpoint

  // POST /callback/:taskId
  async function handleCallback(request: Request, env: Env) {
    const url = new URL(request.url);
    const taskId = url.pathname.split('/').pop();

    const callback = await request.json();
    // callback structure defined below

    // Update task state
    await env.TASK_STORE.put(taskId, JSON.stringify({
      status: callback.status,
      ...callback,
      completedAt: Date.now(),
    }));

    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  6. Implement Status Check Endpoint

  // GET /status/:taskId
  async function getTaskStatus(request: Request, env: Env) {
    const taskId = url.pathname.split('/').pop();
    const taskData = await env.TASK_STORE.get(taskId);

    if (!taskData) {
      return new Response('Task not found', { status: 404 });
    }

    return new Response(taskData, {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  7. Stream Result to Client

  // GET /download/:taskId
  async function downloadResult(request: Request, env: Env) {
    const taskId = url.pathname.split('/').pop();
    const taskData = JSON.parse(await env.TASK_STORE.get(taskId));

    if (taskData.status !== 'success') {
      return new Response('Export not ready or failed', { status: 400 });
    }

    // Fetch from R2
    const r2Object = await env.R2_BUCKET.get(taskData.output_r2_key);

    if (!r2Object) {
      return new Response('File not found in R2', { status: 404 });
    }

    // Stream to client
    return new Response(r2Object.body, {
      headers: {
        'Content-Type': 'application/xml',
        'Content-Disposition': `attachment; filename="${taskData.output_file_name}"`,
        'Content-Length': taskData.output_file_size.toString(),
      },
    });
  }

  ---
  What the Worker Returns via Callback

  Success Callback Payload

  POST ${CALLBACK_URL}

  Request Body:
  {
    // Task identification
    "task_id": "export_mods_abc123",
    "batch_id": "single",  // or batch ID if part of batch

    // Status
    "status": "success",

    // Output file information
    "output_r2_key": "exports/export_mods_abc123/01K9XVBAQZF9EHDRXGBEADTZYY-collection.xml",
    "output_file_name": "01K9XVBAQZF9EHDRXGBEADTZYY-collection.xml",
    "output_file_size": 1748234,  // bytes

    // Performance metrics
    "metrics": {
      "total_time_ms": 2934,        // Total export time
      "entities_exported": 72,       // Entities successfully exported
      "entities_failed": 0,          // Entities that failed
      "peak_memory_mb": 30           // Peak memory usage
    }
  }

  Expected Response: 200 OK

  Error Callback Payload

  POST ${CALLBACK_URL}

  Request Body:
  {
    // Task identification
    "task_id": "export_mods_abc123",
    "batch_id": "single",

    // Status
    "status": "error",

    // Error details
    "error": "Failed to fetch manifest for PI 01K9XVBAQZF9EHDRXGBEADTZYY: 404 Not Found"
  }

  Expected Response: 200 OK

  ---
  Complete Flow Diagram

  ┌─────────────────────────────────────────────────────────────────┐
  │                         CLIENT                                  │
  └────────┬────────────────────────────────────────────────────────┘
           │
           │ 1. POST /export/mods
           │    { pi: "01K9...", options: {...} }
           │
           ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                    ORCHESTRATOR (Cloudflare Worker)             │
  │                                                                  │
  │  1. Generate task_id = "export_mods_abc123"                    │
  │  2. Spawn Fly.io machine with env vars:                        │
  │     - TASK_ID, PI, EXPORT_OPTIONS                              │
  │     - R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY   │
  │     - CALLBACK_URL = "https://orch.../callback/export_..."    │
  │  3. Store task state in KV: { status: 'processing' }           │
  │  4. Return to client: { task_id, status: 'processing' }        │
  └────────┬────────────────────────────────────────────────────────┘
           │
           │ 2. Return task_id immediately
           │
           ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                         CLIENT                                  │
  │  (polls GET /status/:task_id or waits for webhook)             │
  └─────────────────────────────────────────────────────────────────┘

           Meanwhile...

  ┌─────────────────────────────────────────────────────────────────┐
  │            FLY.IO EPHEMERAL MACHINE (Worker)                    │
  │                                                                  │
  │  1. Read env vars (TASK_ID, PI, EXPORT_OPTIONS, etc.)          │
  │  2. Export MODS to temp file:                                  │
  │     /tmp/export_mods_abc123-1704857234567-01K9...-collection.xml│
  │  3. Upload to R2:                                               │
  │     exports/export_mods_abc123/01K9...-collection.xml          │
  │  4. POST callback to CALLBACK_URL:                             │
  │     {                                                           │
  │       task_id: "export_mods_abc123",                           │
  │       status: "success",                                        │
  │       output_r2_key: "exports/export_mods_abc123/...",         │
  │       output_file_name: "01K9...-collection.xml",              │
  │       output_file_size: 1748234,                               │
  │       metrics: { total_time_ms: 2934, ... }                    │
  │     }                                                           │
  │  5. Exit 0 (machine auto-destroys)                             │
  └────────┬────────────────────────────────────────────────────────┘
           │
           │ 3. POST callback with results
           │
           ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                    ORCHESTRATOR                                 │
  │                                                                  │
  │  1. Receive callback at POST /callback/:task_id                │
  │  2. Update KV store:                                            │
  │     {                                                           │
  │       status: "success",                                        │
  │       output_r2_key: "exports/...",                            │
  │       output_file_name: "...",                                 │
  │       output_file_size: 1748234,                               │
  │       metrics: {...}                                            │
  │     }                                                           │
  └─────────────────────────────────────────────────────────────────┘

           Client checks status...

  ┌─────────────────────────────────────────────────────────────────┐
  │                         CLIENT                                  │
  │                                                                  │
  │  1. GET /status/:task_id                                        │
  │     Response: { status: "success", output_r2_key: "..." }      │
  │                                                                  │
  │  2. GET /download/:task_id                                      │
  │     Orchestrator fetches from R2 and streams to client          │
  └─────────────────────────────────────────────────────────────────┘

  ---
  Environment Variables the Orchestrator Must Provide

  # REQUIRED - Task identification
  TASK_ID="export_mods_1704857234567_a3f8c2d1"
  BATCH_ID="single"  # or batch ID for batch operations

  # REQUIRED - Export parameters
  PI="01K9XVBAQZF9EHDRXGBEADTZYY"
  EXPORT_FORMAT="mods"  # Future: "dc", "marcxml", etc.

  # REQUIRED - Export options (JSON string)
  EXPORT_OPTIONS='{"recursive":true,"maxDepth":10,"parallelBatchSize":10,"includeOcr":true,"cheimar
  rosMode":"full"}'

  # REQUIRED - R2 credentials (from orchestrator's env)
  R2_ACCOUNT_ID="..."
  R2_ACCESS_KEY_ID="..."
  R2_SECRET_ACCESS_KEY="..."
  R2_BUCKET="arke-exports"

  # REQUIRED - Callback URL
  CALLBACK_URL="https://orchestrator.workers.dev/callback/export_mods_1704857234567_a3f8c2d1"

  # AUTOMATIC - Fly.io provides
  FLY_MACHINE_ID="machine_id_12345"

  ---
  Key Requirements for Orchestrator

  1. Task ID Generation: Must be unique and URL-safe
  2. State Management: Store task state in KV/DO (status, R2 key, metrics)
  3. Callback Handler: Accept POST with success/error payload, update state
  4. Status Endpoint: Allow clients to poll task status
  5. Download Endpoint: Stream file from R2 to client when ready
  6. R2 Credentials: Pass to worker via env vars
  7. Timeout Handling: Set reasonable timeout for machine spawn (e.g., 10 minutes)
  8. Cleanup: Delete R2 files after download or expiration (e.g., 24 hours)