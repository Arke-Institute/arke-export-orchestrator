/**
 * Arke Export Orchestrator
 *
 * Cloudflare Worker that orchestrates MODS export jobs by:
 * 1. Receiving export requests from clients
 * 2. Spawning ephemeral Fly.io machines to perform exports
 * 3. Receiving callbacks from workers with results
 * 4. Streaming completed exports from R2 to clients
 *
 * Flow:
 * Client → POST /export/mods → Orchestrator → Fly.io Machine
 *   ↓
 * GET /status/:taskId (polling)
 *   ↓
 * Fly Machine → POST /callback/:taskId → Orchestrator
 *   ↓
 * Client → GET /download/:taskId → Orchestrator → R2 → Client
 */

import type {
  Env,
  ExportRequest,
  ExportStartResponse,
  StatusResponse,
  CallbackPayload,
  TaskState,
} from './types';
import { spawnExportMachine } from './fly';
import { generateTaskId, jsonResponse, errorResponse } from './utils';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ========================================================================
    // ENDPOINT 1: Create Export Job
    // POST /export/mods
    // ========================================================================
    if (path === '/export/mods' && request.method === 'POST') {
      return handleExportRequest(request, env);
    }

    // ========================================================================
    // ENDPOINT 2: Check Task Status
    // GET /status/:taskId
    // ========================================================================
    if (path.startsWith('/status/') && request.method === 'GET') {
      const taskId = path.split('/')[2];
      return handleStatusRequest(taskId, env);
    }

    // ========================================================================
    // ENDPOINT 3: Receive Callback from Fly.io Worker
    // POST /callback/:taskId
    // ========================================================================
    if (path.startsWith('/callback/') && request.method === 'POST') {
      const taskId = path.split('/')[2];
      return handleCallback(taskId, request, env);
    }

    // ========================================================================
    // ENDPOINT 4: Download Export Result
    // GET /download/:taskId
    // ========================================================================
    if (path.startsWith('/download/') && request.method === 'GET') {
      const taskId = path.split('/')[2];
      return handleDownload(taskId, env);
    }

    // ========================================================================
    // ENDPOINT 5: Health Check
    // GET /health
    // ========================================================================
    if (path === '/health' && request.method === 'GET') {
      return jsonResponse({ status: 'ok', service: 'arke-export-orchestrator' });
    }

    // ========================================================================
    // 404 - Not Found
    // ========================================================================
    return errorResponse('Not found', 404);
  },
};

// ============================================================================
// Handler Functions
// ============================================================================

/**
 * Handle POST /export/mods
 *
 * 1. Validate request
 * 2. Generate task ID
 * 3. Spawn Fly.io machine
 * 4. Store task state in KV
 * 5. Return task ID to client
 */
async function handleExportRequest(request: Request, env: Env): Promise<Response> {
  try {
    // Parse request body
    const body: ExportRequest = await request.json();
    const { pi, options } = body;

    // Validate required fields
    if (!pi) {
      return errorResponse('Missing required field: pi', 400);
    }

    // Generate unique task ID
    const taskId = generateTaskId();
    const batchId = 'single'; // For now, only single exports

    // Generate callback URL
    const url = new URL(request.url);
    const callbackUrl = `${url.origin}/callback/${taskId}`;

    console.log(`[Export] Starting export for PI ${pi}, task ${taskId}`);

    // Spawn Fly.io machine
    const { machineId, instanceId } = await spawnExportMachine(env, {
      pi,
      taskId,
      batchId,
      callbackUrl,
      exportOptions: options || {},
    });

    // Store initial task state in KV
    const taskState: TaskState = {
      task_id: taskId,
      batch_id: batchId,
      status: 'processing',
      pi,
      options: options || {},
      machine_id: machineId,
      instance_id: instanceId,
      created_at: Date.now(),
    };

    await env.TASK_STORE.put(taskId, JSON.stringify(taskState), {
      expirationTtl: 3600, // 1 hour expiration for processing tasks
    });

    // Return task ID to client
    const response: ExportStartResponse = {
      task_id: taskId,
      status: 'processing',
      message: 'Export job started. Use task_id to check status.',
    };

    console.log(`[Export] Task ${taskId} created, machine ${machineId} spawned`);

    return jsonResponse(response);
  } catch (error: any) {
    console.error('[Export] Error:', error);
    return errorResponse(error.message || 'Failed to start export job');
  }
}

/**
 * Handle GET /status/:taskId
 *
 * Return current task state from KV
 */
async function handleStatusRequest(taskId: string, env: Env): Promise<Response> {
  try {
    const taskData = await env.TASK_STORE.get(taskId);

    if (!taskData) {
      return errorResponse('Task not found', 404);
    }

    const taskState: TaskState = JSON.parse(taskData);

    // Build status response
    const response: StatusResponse = {
      task_id: taskState.task_id,
      status: taskState.status,
      pi: taskState.pi,
      created_at: taskState.created_at,
      completed_at: taskState.completed_at,
      output_r2_key: taskState.output_r2_key,
      output_file_name: taskState.output_file_name,
      output_file_size: taskState.output_file_size,
      metrics: taskState.metrics,
      error: taskState.error,
    };

    return jsonResponse(response);
  } catch (error: any) {
    console.error('[Status] Error:', error);
    return errorResponse(error.message || 'Failed to get task status');
  }
}

/**
 * Handle POST /callback/:taskId
 *
 * Receive callback from Fly.io worker with results
 * Update task state in KV
 */
async function handleCallback(
  taskId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    // Parse callback payload
    const callback: CallbackPayload = await request.json();

    console.log(`[Callback] Received callback for task ${taskId}, status: ${callback.status}`);

    // Get existing task state
    const existingData = await env.TASK_STORE.get(taskId);

    if (!existingData) {
      console.warn(`[Callback] Task ${taskId} not found in KV`);
      return errorResponse('Task not found', 404);
    }

    const taskState: TaskState = JSON.parse(existingData);

    // Update task state with callback data
    taskState.status = callback.status;
    taskState.completed_at = Date.now();

    if (callback.status === 'success') {
      taskState.output_r2_key = callback.output_r2_key;
      taskState.output_file_name = callback.output_file_name;
      taskState.output_file_size = callback.output_file_size;
      taskState.metrics = callback.metrics;
      console.log(`[Callback] Task ${taskId} succeeded: ${callback.output_file_name}`);
    } else {
      taskState.error = callback.error;
      console.error(`[Callback] Task ${taskId} failed: ${callback.error}`);
    }

    // Store updated state with longer TTL (24 hours for completed tasks)
    await env.TASK_STORE.put(taskId, JSON.stringify(taskState), {
      expirationTtl: 86400, // 24 hours
    });

    return jsonResponse({ received: true });
  } catch (error: any) {
    console.error('[Callback] Error:', error);
    return errorResponse(error.message || 'Failed to process callback');
  }
}

/**
 * Handle GET /download/:taskId
 *
 * Stream export result from R2 to client
 */
async function handleDownload(taskId: string, env: Env): Promise<Response> {
  try {
    // Get task state
    const taskData = await env.TASK_STORE.get(taskId);

    if (!taskData) {
      return errorResponse('Task not found', 404);
    }

    const taskState: TaskState = JSON.parse(taskData);

    // Check if task is complete
    if (taskState.status !== 'success') {
      return errorResponse(
        `Export not ready or failed. Status: ${taskState.status}`,
        400
      );
    }

    // Check if we have R2 key
    if (!taskState.output_r2_key) {
      return errorResponse('Export file not available', 500);
    }

    console.log(`[Download] Streaming ${taskState.output_r2_key} for task ${taskId}`);

    // Fetch from R2
    const r2Object = await env.R2_BUCKET.get(taskState.output_r2_key);

    if (!r2Object) {
      console.error(`[Download] File not found in R2: ${taskState.output_r2_key}`);
      return errorResponse('Export file not found in storage', 404);
    }

    // Stream to client
    return new Response(r2Object.body, {
      headers: {
        'Content-Type': 'application/xml',
        'Content-Disposition': `attachment; filename="${taskState.output_file_name}"`,
        'Content-Length': taskState.output_file_size?.toString() || '',
      },
    });
  } catch (error: any) {
    console.error('[Download] Error:', error);
    return errorResponse(error.message || 'Failed to download export');
  }
}
