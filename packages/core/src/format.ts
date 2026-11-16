import type { ThreadMessage, BridgeToolDefinition } from './types.js';
export function formatThreadMessage(frame: ThreadMessage): string {
  return [
    `# GroupChat: ${frame.groupChat.title}`, `URL: ${frame.groupChat.url}`,
    `Members: ${frame.groupChat.members.map(m => `${m.name} (${m.id})${m.orgName ? ` [${m.orgName}]` : ''}`).join(', ')}`,
    frame.reason === 'joined' ? 'You have joined this GroupChat.' : '',
    ...frame.messages.map(m => [
      `${m.authorName}${m.authorId ? ` (${m.authorId})` : ''} [${m.id}] ${m.createdAt}${m.replyToMessageId ? ` (replyToMessageId: ${m.replyToMessageId})` : ''}:`,
      m.content, ...(m.attachments ?? []).map(a => `Attachment: ${a.name} (${a.mimeType}, ${a.size} bytes) ${a.url}${a.transcript ? `\nTranscript: ${a.transcript}` : ''}`),
    ].join('\n')),
  ].filter(Boolean).join('\n\n');
}

/** Prefer the server-formatted prompt, including silent-turn reminders. */
export function resolveThreadPrompt(frame: ThreadMessage): string {
  return typeof frame.prompt === 'string' && frame.prompt.length > 0 ? frame.prompt : formatThreadMessage(frame);
}

export function findTool(tools: BridgeToolDefinition[], name: string): BridgeToolDefinition {
  const tool = tools.find(tool => tool.name === name);
  if (!tool) throw new Error(`Missing bridge tool: ${name}`);
  return tool;
}
