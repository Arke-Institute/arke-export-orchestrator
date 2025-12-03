// ============================================================================
// Cloudflare Worker Environment
// ============================================================================

export interface Env {
  // Bindings
  TASK_STORE: DurableObjectNamespace;
  R2_BUCKET: R2Bucket;

  // Secrets
  FLY_API_TOKEN: string;

  // Config vars
  FLY_APP_NAME: string;
  FLY_REGION: string;
  FLY_WORKER_IMAGE: string;
  WORKER_MEMORY_MB: string;
  WORKER_CPUS: string;
}

// ============================================================================
// Export Request & Options
// ============================================================================

export interface ExportRequest {
  pi: string;                  // Permanent identifier to export
  options?: ExportOptions;     // Export configuration
}

/**
 * Export options for Pinax JSON export
 */
export interface ExportOptions {
  // Recursion
  recursive?: boolean;              // Export child entities (default: false)
  maxDepth?: number;                // Max recursion depth (default: 10, max: 50)

  // Content filtering
  includeOcr?: boolean;             // Include OCR text (default: true)
  maxTextLength?: number;           // Truncate large texts (default: 100000 chars)

  // Entity data source
  entitySource?: 'graphdb' | 'cheimarros' | 'both';  // Default: 'graphdb'

  // Component filtering
  includeComponents?: boolean;      // Include component list (default: true)

  // Processing
  parallelBatchSize?: number;       // Parallel processing batch size (default: 10)
}

// ============================================================================
// Task State (stored in KV)
// ============================================================================

export type TaskStatus = 'processing' | 'success' | 'error';

export interface TaskState {
  // Identification
  task_id: string;
  batch_id: string;           // 'single' for single exports, or batch ID

  // Status
  status: TaskStatus;

  // Request data
  pi: string;
  options: ExportOptions;

  // Fly.io machine info
  machine_id?: string;
  instance_id?: string;

  // Output (populated on success)
  output_r2_key?: string;
  output_file_name?: string;
  output_file_size?: number;

  // Metrics (populated on success)
  metrics?: ExportMetrics;

  // Error (populated on failure)
  error?: string;

  // Timestamps
  created_at: number;         // Unix timestamp (ms)
  completed_at?: number;      // Unix timestamp (ms)
}

export interface ExportMetrics {
  total_time_ms: number;
  entities_exported: number;
  entities_failed: number;
  entities_incomplete?: number;  // Records exported with minimal metadata (missing PINAX)
  peak_memory_mb: number;
}

// ============================================================================
// Callback Payload (from Fly.io worker)
// ============================================================================

export interface CallbackPayload {
  // Task identification
  task_id: string;
  batch_id: string;

  // Status
  status: 'success' | 'error';

  // Success fields
  output_r2_key?: string;
  output_file_name?: string;
  output_file_size?: number;
  metrics?: ExportMetrics;

  // Error fields
  error?: string;
}

// ============================================================================
// HTTP Responses
// ============================================================================

export interface ExportStartResponse {
  task_id: string;
  status: 'processing';
  message: string;
}

export interface StatusResponse {
  task_id: string;
  status: TaskStatus;
  pi: string;
  created_at: number;
  completed_at?: number;
  output_r2_key?: string;
  output_file_name?: string;
  output_file_size?: number;
  metrics?: ExportMetrics;
  error?: string;
}

export interface ErrorResponse {
  error: string;
}

// ============================================================================
// Fly.io Machine API Types
// ============================================================================

export interface FlyMachineConfig {
  config: {
    image: string;
    env: Record<string, string>;
    auto_destroy: boolean;
    restart: {
      policy: 'no';
    };
    guest?: {
      cpu_kind: 'shared' | 'performance';
      cpus: number;
      memory_mb: number;
    };
  };
  region: string;
}

export interface FlyMachineResponse {
  id: string;
  instance_id: string;
  state: string;
  region: string;
  // ... other fields we don't need
}
