/**
 * TaskStore Durable Object
 *
 * Provides strongly consistent storage for export task state using SQLite.
 * Each task gets its own Durable Object instance for predictable routing.
 */

import type { TaskState, CallbackPayload } from './types';

export class TaskStore {
  private state: DurableObjectState;
  private sql: SqlStorage;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.sql = state.storage.sql;

    // Initialize SQLite schema
    this.initializeSchema();
  }

  /**
   * Create SQLite table for task storage
   */
  private initializeSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        status TEXT NOT NULL,
        pi TEXT NOT NULL,
        options TEXT NOT NULL,
        machine_id TEXT,
        instance_id TEXT,
        output_r2_key TEXT,
        output_file_name TEXT,
        output_file_size INTEGER,
        metrics TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      )
    `);
  }

  /**
   * HTTP handler for Durable Object requests
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/create' && request.method === 'POST') {
        const taskState: TaskState = await request.json();
        await this.createTask(taskState);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path === '/get' && request.method === 'GET') {
        const taskId = url.searchParams.get('taskId');
        if (!taskId) {
          return new Response(JSON.stringify({ error: 'Missing taskId' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const task = await this.getTask(taskId);
        return new Response(JSON.stringify(task), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path === '/complete' && request.method === 'POST') {
        const { taskId, callback } = await request.json();
        await this.completeTask(taskId, callback);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not found', { status: 404 });
    } catch (error: any) {
      console.error('[TaskStore] Error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  /**
   * Create a new task
   */
  private async createTask(taskState: TaskState): Promise<void> {
    const stmt = this.sql.exec(`
      INSERT INTO tasks (
        task_id, batch_id, status, pi, options,
        machine_id, instance_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      taskState.task_id,
      taskState.batch_id,
      taskState.status,
      taskState.pi,
      JSON.stringify(taskState.options),
      taskState.machine_id || null,
      taskState.instance_id || null,
      taskState.created_at
    );

    console.log(`[TaskStore] Created task ${taskState.task_id}`);
  }

  /**
   * Get task by ID
   */
  private async getTask(taskId: string): Promise<TaskState | null> {
    const rows = this.sql.exec(`
      SELECT * FROM tasks WHERE task_id = ?
    `, taskId).toArray();

    if (rows.length === 0) {
      return null;
    }

    const row = rows[0] as any;

    // Reconstruct TaskState from SQLite row
    const taskState: TaskState = {
      task_id: row.task_id,
      batch_id: row.batch_id,
      status: row.status,
      pi: row.pi,
      options: JSON.parse(row.options),
      machine_id: row.machine_id || undefined,
      instance_id: row.instance_id || undefined,
      output_r2_key: row.output_r2_key || undefined,
      output_file_name: row.output_file_name || undefined,
      output_file_size: row.output_file_size || undefined,
      metrics: row.metrics ? JSON.parse(row.metrics) : undefined,
      error: row.error || undefined,
      created_at: row.created_at,
      completed_at: row.completed_at || undefined,
    };

    return taskState;
  }

  /**
   * Complete a task with callback data
   */
  private async completeTask(taskId: string, callback: CallbackPayload): Promise<void> {
    const now = Date.now();

    if (callback.status === 'success') {
      this.sql.exec(`
        UPDATE tasks
        SET status = ?,
            completed_at = ?,
            output_r2_key = ?,
            output_file_name = ?,
            output_file_size = ?,
            metrics = ?
        WHERE task_id = ?
      `,
        callback.status,
        now,
        callback.output_r2_key || null,
        callback.output_file_name || null,
        callback.output_file_size || null,
        callback.metrics ? JSON.stringify(callback.metrics) : null,
        taskId
      );
      console.log(`[TaskStore] Task ${taskId} completed successfully`);
    } else {
      this.sql.exec(`
        UPDATE tasks
        SET status = ?,
            completed_at = ?,
            error = ?
        WHERE task_id = ?
      `,
        callback.status,
        now,
        callback.error || null,
        taskId
      );
      console.error(`[TaskStore] Task ${taskId} failed: ${callback.error}`);
    }
  }
}
