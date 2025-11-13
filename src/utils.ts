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
 * CORS headers helper
 */
export function corsHeaders(origin?: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400', // 24 hours
  };
}

/**
 * Create JSON response helper with CORS
 */
export function jsonResponse(data: any, status: number = 200, origin?: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

/**
 * Create error response helper with CORS
 */
export function errorResponse(message: string, status: number = 500, origin?: string): Response {
  return jsonResponse({ error: message }, status, origin);
}
