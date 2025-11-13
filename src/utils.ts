/**
 * Generate a unique task ID for an export job
 * Format: export_mods_{timestamp}_{random}
 */
export function generateTaskId(): string {
  const timestamp = Date.now();
  const random = crypto.randomUUID().slice(0, 8);
  return `export_mods_${timestamp}_${random}`;
}

/**
 * Generate R2 key for export output
 * Format: exports/{task_id}/{pi}-collection.xml
 */
export function generateR2Key(taskId: string, pi: string): string {
  return `exports/${taskId}/${pi}-collection.xml`;
}

/**
 * Create JSON response helper
 */
export function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Create error response helper
 */
export function errorResponse(message: string, status: number = 500): Response {
  return jsonResponse({ error: message }, status);
}
