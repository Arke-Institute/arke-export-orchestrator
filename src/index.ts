/**
 * Arke Export Orchestrator
 *
 * Cloudflare Worker that orchestrates Pinax JSON export jobs by:
 * 1. Receiving export requests from clients
 * 2. Spawning ephemeral Fly.io machines to perform exports
 * 3. Receiving callbacks from workers with results
 * 4. Streaming completed exports from R2 to clients
 *
 * Endpoints:
 * - POST /export - Create export job
 * - GET  /status/:taskId - Check export status
 * - POST /callback/:taskId - Receive worker callback
 * - GET  /download/:taskId - Download completed export
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

// Export Durable Object for Wrangler
export { TaskStore } from './task-store';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = request.headers.get('Origin') || undefined;

    // ========================================================================
    // CORS Preflight Handler
    // ========================================================================
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin || '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // ========================================================================
    // ENDPOINT 1: Create Export Job
    // POST /export
    // ========================================================================
    if (path === '/export' && request.method === 'POST') {
      return handleExportRequest(request, env, origin);
    }

    // ========================================================================
    // ENDPOINT 2: Check Task Status
    // GET /status/:taskId
    // ========================================================================
    if (path.startsWith('/status/') && request.method === 'GET') {
      const taskId = path.split('/')[2];
      return handleStatusRequest(taskId, env, origin);
    }

    // ========================================================================
    // ENDPOINT 3: Receive Callback from Fly.io Worker
    // POST /callback/:taskId
    // ========================================================================
    if (path.startsWith('/callback/') && request.method === 'POST') {
      const taskId = path.split('/')[2];
      return handleCallback(taskId, request, env, origin);
    }

    // ========================================================================
    // ENDPOINT 4: Download Export Result
    // GET /download/:taskId
    // ========================================================================
    if (path.startsWith('/download/') && request.method === 'GET') {
      const taskId = path.split('/')[2];
      return handleDownload(taskId, env, origin);
    }

    // ========================================================================
    // ENDPOINT 5: Health Check
    // GET /health
    // ========================================================================
    if (path === '/health' && request.method === 'GET') {
      return jsonResponse({ status: 'ok', service: 'arke-export-orchestrator' }, 200, origin);
    }

    // ========================================================================
    // ENDPOINT 6: JSON Schema
    // GET /schemas/export/v1
    // ========================================================================
    if (path === '/schemas/export/v1' && request.method === 'GET') {
      return handleSchema(origin);
    }

    // ========================================================================
    // 404 - Not Found
    // ========================================================================
    return errorResponse('Not found', 404, origin);
  },
};

// ============================================================================
// Handler Functions
// ============================================================================

/**
 * Handle POST /export
 *
 * 1. Validate request
 * 2. Generate task ID
 * 3. Spawn Fly.io machine
 * 4. Store task state in Durable Object
 * 5. Return task ID to client
 */
async function handleExportRequest(
  request: Request,
  env: Env,
  origin?: string
): Promise<Response> {
  try {
    // Parse request body
    const body: ExportRequest = await request.json();
    const { pi, options } = body;

    // Validate required fields
    if (!pi) {
      return errorResponse('Missing required field: pi', 400, origin);
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

    // Store initial task state in Durable Object
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

    // Get DO stub for this task
    const id = env.TASK_STORE.idFromName(taskId);
    const stub = env.TASK_STORE.get(id);
    await stub.fetch('https://task-store/create', {
      method: 'POST',
      body: JSON.stringify(taskState),
    });

    // Return task ID to client
    const response: ExportStartResponse = {
      task_id: taskId,
      status: 'processing',
      message: 'Export job started. Use task_id to check status.',
    };

    console.log(`[Export] Task ${taskId} created, machine ${machineId} spawned`);

    return jsonResponse(response, 200, origin);
  } catch (error: any) {
    console.error('[Export] Error:', error);
    return errorResponse(error.message || 'Failed to start export job', 500, origin);
  }
}

/**
 * Handle GET /status/:taskId
 *
 * Return current task state from Durable Object
 */
async function handleStatusRequest(taskId: string, env: Env, origin?: string): Promise<Response> {
  try {
    // Get DO stub for this task
    const id = env.TASK_STORE.idFromName(taskId);
    const stub = env.TASK_STORE.get(id);

    const doResponse = await stub.fetch(`https://task-store/get?taskId=${taskId}`);
    const taskState: TaskState | null = await doResponse.json();

    if (!taskState) {
      return errorResponse('Task not found', 404, origin);
    }

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

    return jsonResponse(response, 200, origin);
  } catch (error: any) {
    console.error('[Status] Error:', error);
    return errorResponse(error.message || 'Failed to get task status', 500, origin);
  }
}

/**
 * Handle POST /callback/:taskId
 *
 * Receive callback from Fly.io worker with results
 * Update task state in Durable Object
 */
async function handleCallback(
  taskId: string,
  request: Request,
  env: Env,
  origin?: string
): Promise<Response> {
  try {
    // Parse callback payload
    const callback: CallbackPayload = await request.json();

    console.log(`[Callback] Received callback for task ${taskId}, status: ${callback.status}`);

    // Get DO stub for this task
    const id = env.TASK_STORE.idFromName(taskId);
    const stub = env.TASK_STORE.get(id);

    // Update task with callback data
    await stub.fetch('https://task-store/complete', {
      method: 'POST',
      body: JSON.stringify({ taskId, callback }),
    });

    return jsonResponse({ received: true });
  } catch (error: any) {
    console.error('[Callback] Error:', error);
    return errorResponse(error.message || 'Failed to process callback', 500, origin);
  }
}

/**
 * Handle GET /download/:taskId
 *
 * Stream export result from R2 to client
 */
async function handleDownload(taskId: string, env: Env, origin?: string): Promise<Response> {
  try {
    // Get task state from Durable Object
    const id = env.TASK_STORE.idFromName(taskId);
    const stub = env.TASK_STORE.get(id);

    const doResponse = await stub.fetch(`https://task-store/get?taskId=${taskId}`);
    const taskState: TaskState | null = await doResponse.json();

    if (!taskState) {
      return errorResponse('Task not found', 404, origin);
    }

    // Check if task is complete
    if (taskState.status !== 'success') {
      return errorResponse(
        `Export not ready or failed. Status: ${taskState.status}`,
        400,
        origin
      );
    }

    // Check if we have R2 key
    if (!taskState.output_r2_key) {
      return errorResponse('Export file not available', 500, origin);
    }

    console.log(`[Download] Streaming ${taskState.output_r2_key} for task ${taskId}`);

    // Fetch from R2
    const r2Object = await env.R2_BUCKET.get(taskState.output_r2_key);

    if (!r2Object) {
      console.error(`[Download] File not found in R2: ${taskState.output_r2_key}`);
      return errorResponse('Export file not found in storage', 404, origin);
    }

    // Stream to client with CORS headers (JSON format)
    return new Response(r2Object.body, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${taskState.output_file_name}"`,
        'Content-Length': taskState.output_file_size?.toString() || '',
        'Access-Control-Allow-Origin': origin || '*',
      },
    });
  } catch (error: any) {
    console.error('[Download] Error:', error);
    return errorResponse(error.message || 'Failed to download export', 500, origin);
  }
}

/**
 * Handle GET /schemas/export/v1
 *
 * Returns the JSON Schema for Pinax exports
 */
function handleSchema(origin?: string): Response {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://export.arke.institute/schemas/export/v1',
    title: 'Pinax Export',
    description: 'Arke Institute Pinax JSON export format',
    type: 'object',
    required: ['$schema', 'version', 'exported_at', 'export_options', 'root'],
    properties: {
      $schema: {
        type: 'string',
        const: 'https://export.arke.institute/schemas/export/v1',
      },
      version: {
        type: 'string',
        const: '1.0.0',
      },
      exported_at: {
        type: 'string',
        format: 'date-time',
        description: 'ISO 8601 timestamp of when the export was created',
      },
      export_options: {
        $ref: '#/$defs/ExportOptions',
      },
      root: {
        $ref: '#/$defs/Entity',
      },
    },
    $defs: {
      ExportOptions: {
        type: 'object',
        properties: {
          recursive: { type: 'boolean', default: false },
          maxDepth: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          includeOcr: { type: 'boolean', default: true },
          maxTextLength: { type: 'integer', default: 100000 },
          entitySource: {
            type: 'string',
            enum: ['none', 'graphdb', 'cheimarros', 'both'],
            default: 'graphdb',
          },
          includeComponents: { type: 'boolean', default: true },
          componentTypes: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['ref', 'pinax', 'description', 'cheimarros', 'other'],
            },
          },
          parallelBatchSize: { type: 'integer', default: 10 },
        },
      },
      Entity: {
        type: 'object',
        required: ['pi', 'manifest_cid', 'ver', 'ts', 'depth', 'pinax', 'description'],
        properties: {
          pi: { type: 'string', description: 'Permanent identifier' },
          manifest_cid: { type: 'string', description: 'IPFS CID of the manifest' },
          ver: { type: 'integer', description: 'Version number' },
          ts: { type: 'string', format: 'date-time', description: 'Timestamp' },
          parent_pi: { type: 'string', description: 'Parent entity PI' },
          depth: { type: 'integer', description: 'Depth in the export tree' },
          pinax: {
            oneOf: [{ $ref: '#/$defs/PinaxMetadata' }, { type: 'null' }],
          },
          description: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
          },
          description_truncated: { type: 'boolean' },
          entities: {
            type: 'array',
            items: { $ref: '#/$defs/LinkedEntity' },
          },
          relationships: {
            type: 'array',
            items: { $ref: '#/$defs/LinkedRelationship' },
          },
          cheimarros: { $ref: '#/$defs/CheimarrosGraph' },
          components: {
            type: 'array',
            items: { $ref: '#/$defs/Component' },
          },
          children: {
            type: 'array',
            items: { $ref: '#/$defs/Entity' },
          },
          children_count: { type: 'integer' },
        },
      },
      PinaxMetadata: {
        type: 'object',
        required: ['id', 'title', 'type', 'creator', 'institution', 'created', 'access_url'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          type: {
            type: 'string',
            enum: [
              'Collection', 'Dataset', 'Event', 'Image', 'InteractiveResource',
              'MovingImage', 'PhysicalObject', 'Service', 'Software', 'Sound',
              'StillImage', 'Text',
            ],
          },
          creator: {
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          institution: { type: 'string' },
          created: { type: 'string' },
          access_url: { type: 'string', format: 'uri' },
          language: { type: 'string' },
          subjects: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
          source: { type: 'string' },
          rights: { type: 'string' },
          place: {
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
        },
      },
      LinkedEntity: {
        type: 'object',
        required: ['canonical_id', 'code', 'label', 'type', 'url'],
        properties: {
          canonical_id: { type: 'string' },
          code: { type: 'string' },
          label: { type: 'string' },
          type: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          properties: { type: 'object' },
          created_by_pi: { type: 'string' },
          source_pis: { type: 'array', items: { type: 'string' } },
          first_seen: { type: 'string' },
          last_updated: { type: 'string' },
        },
      },
      LinkedRelationship: {
        type: 'object',
        required: ['subject_id', 'predicate', 'object_id', 'source_pi'],
        properties: {
          subject_id: { type: 'string' },
          predicate: { type: 'string' },
          object_id: { type: 'string' },
          subject_label: { type: 'string' },
          object_label: { type: 'string' },
          source_pi: { type: 'string' },
          properties: { type: 'object' },
          created_at: { type: 'string' },
        },
      },
      CheimarrosGraph: {
        type: 'object',
        required: ['entities'],
        properties: {
          entities: {
            type: 'object',
            additionalProperties: { $ref: '#/$defs/CheimarrosEntity' },
          },
          relations: {
            type: 'array',
            items: { $ref: '#/$defs/CheimarrosRelation' },
          },
        },
      },
      CheimarrosEntity: {
        type: 'object',
        required: ['type', 'label'],
        properties: {
          type: { type: 'string' },
          label: { type: 'string' },
          properties: { type: 'object' },
          source: { type: 'string' },
        },
      },
      CheimarrosRelation: {
        type: 'object',
        required: ['source', 'target', 'type'],
        properties: {
          source: { type: 'string' },
          target: { type: 'string' },
          type: { type: 'string' },
          properties: { type: 'object' },
        },
      },
      Component: {
        type: 'object',
        required: ['key', 'cid', 'url', 'type'],
        properties: {
          key: { type: 'string' },
          cid: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          type: {
            type: 'string',
            enum: ['ref', 'pinax', 'description', 'cheimarros', 'other'],
          },
          ref: {
            type: 'object',
            required: ['mime_type', 'size', 'cdn_url'],
            properties: {
              mime_type: { type: 'string' },
              size: { type: 'integer' },
              cdn_url: { type: 'string', format: 'uri' },
              ocr_text: { type: 'string' },
              ocr_truncated: { type: 'boolean' },
            },
          },
        },
      },
    },
  };

  return new Response(JSON.stringify(schema, null, 2), {
    headers: {
      'Content-Type': 'application/schema+json',
      'Access-Control-Allow-Origin': origin || '*',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
