import type { Env, ExportOptions, FlyMachineConfig, FlyMachineResponse } from './types';

const FLY_API_BASE = 'https://api.machines.dev/v1';

export interface SpawnMachineOptions {
  pi: string;
  taskId: string;
  batchId: string;
  callbackUrl: string;
  exportOptions: ExportOptions;
}

/**
 * Spawn a Fly.io ephemeral machine for MODS export
 *
 * The machine will:
 * 1. Pull the Docker image
 * 2. Run the export worker
 * 3. Upload results to R2
 * 4. POST callback to orchestrator
 * 5. Auto-destroy on exit
 */
export async function spawnExportMachine(
  env: Env,
  options: SpawnMachineOptions
): Promise<{ machineId: string; instanceId: string }> {
  const { pi, taskId, batchId, callbackUrl, exportOptions } = options;

  // Build machine configuration
  const machineConfig: FlyMachineConfig = {
    config: {
      image: env.FLY_WORKER_IMAGE,

      // Environment variables for the worker
      env: {
        // Task identification
        TASK_ID: taskId,
        PI: pi,
        EXPORT_FORMAT: 'mods',
        BATCH_ID: batchId,

        // Export options (as JSON string)
        EXPORT_OPTIONS: JSON.stringify(exportOptions),

        // Callback URL for worker to report results
        CALLBACK_URL: callbackUrl,

        // Note: R2 credentials are bound directly to the worker via wrangler.toml
        // We don't need to pass them here
      },

      // Machine lifecycle
      auto_destroy: true,  // Destroy after process exits
      restart: {
        policy: 'no',      // Don't restart on failure
      },

      // Resource allocation
      guest: {
        cpu_kind: 'shared',
        cpus: parseInt(env.WORKER_CPUS),
        memory_mb: parseInt(env.WORKER_MEMORY_MB),
      },
    },

    // Geographic placement
    region: env.FLY_REGION,
  };

  // Spawn the machine
  const response = await fetch(
    `${FLY_API_BASE}/apps/${env.FLY_APP_NAME}/machines`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.FLY_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(machineConfig),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to spawn Fly.io machine: ${response.status} ${error}`);
  }

  const machine: FlyMachineResponse = await response.json();

  console.log(`[Fly] Spawned machine ${machine.id} for task ${taskId}`);

  return {
    machineId: machine.id,
    instanceId: machine.instance_id,
  };
}

/**
 * Get the status of a Fly.io machine (optional, for debugging)
 */
export async function getMachineStatus(
  env: Env,
  machineId: string
): Promise<FlyMachineResponse> {
  const response = await fetch(
    `${FLY_API_BASE}/apps/${env.FLY_APP_NAME}/machines/${machineId}`,
    {
      headers: {
        'Authorization': `Bearer ${env.FLY_API_TOKEN}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to get machine status: ${response.status}`);
  }

  return await response.json();
}
