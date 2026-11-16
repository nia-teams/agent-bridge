import type { TurnContext, TurnResult } from './session-host.js';
export interface SdkEvent { type: string; session_id?: string; subtype?: string; is_error?: boolean; result?: unknown; errors?: string[]; parent_tool_use_id?: string | null; message?: { content?: Array<{ type: string; text?: string; name?: string }> }; tool_name?: string }
/** Normalizes the common documented SDK assistant/result events, not the underlying wire. */
export async function consumeSdkQuery(query: AsyncIterable<unknown> & { close?: () => void; interrupt?: () => Promise<unknown> }, context: TurnContext): Promise<TurnResult> {
  let sawResult = false, lastSession: string | undefined;
  const abort = () => { try { if (query.close) query.close(); else void query.interrupt?.().catch(() => {}); } catch {} };
  context.signal.addEventListener('abort', abort, { once: true });
  try {
    context.signal.throwIfAborted();
    for await (const raw of query) {
      if (!raw || typeof raw !== 'object') throw new Error('Invalid SDK event');
      const event = raw as SdkEvent;
      context.signal.throwIfAborted();
      if (event.session_id && event.session_id !== lastSession) { await context.session(event.session_id); lastSession = event.session_id; }
      if (event.type === 'assistant' && !event.parent_tool_use_id) {
        const tool = event.message?.content?.find(b => b.type === 'tool_use');
        if (tool) await context.activity('executing', `Using ${tool.name ?? 'tool'}…`);
      }
      if (event.type === 'tool_progress') await context.activity('executing', `Using ${event.tool_name ?? 'tool'}…`);
      if (event.type === 'result') {
        sawResult = true;
        if (event.is_error || event.subtype !== 'success') throw new Error(event.errors?.join('\n') || `Runtime turn failed: ${event.subtype}`);
        break;
      }
    }
    context.signal.throwIfAborted();
    if (!sawResult) throw new Error('Runtime stream ended without a result');
    return;
  } finally { context.signal.removeEventListener('abort', abort); query.close?.(); }
}
