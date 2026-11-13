/** Agent Bridge v1 wire values. No host-runtime imports. */
export interface Credentials {
  serverUrl: string;
  teamId: string;
  agentSlug: string;
  agentName: string;
  issuer: string;
  keyGeneration: number;
  hostLabel: string;
  publicKeyPem: string;
  privateKeyPem: string;
  pairedAt: string;
}
export interface PushBase {
  protocolVersion: 1;
  deliveryId: string;
  groupChatId: string;
  sessionId: string;
  agentThreadId: string;
}
export interface ThreadMessage extends PushBase {
  type: 'thread.message';
  reason: 'message' | 'joined';
  groupChat: { title: string; url: string; members: Array<{ kind: 'human' | 'agent'; id: string; name: string; orgName?: string }> };
  invokedBy?: { userId?: string; userName: string };
  triggerMessageId: string;
  messages: Array<{
    id: string; kind: 'human' | 'agent' | 'system'; authorId?: string; authorName: string;
    replyToMessageId?: string; content: string; createdAt: string;
    attachments?: Array<{ name: string; mimeType: string; size: number; url: string; transcript?: string }>;
  }>;
}
export interface CardAction extends PushBase {
  type: 'card.action'; cardId: string; decision: 'approved' | 'canceled';
  clickedBy: { userId: string; name: string; teamRole?: 'owner' | 'admin' | 'member' };
  _meta?: Record<string, unknown>;
}
export interface ThreadCancel extends PushBase {
  type: 'thread.cancel'; reason: 'user_aborted' | 'removed_from_group';
}
export type PushFrame = ThreadMessage | CardAction | ThreadCancel;
export interface ReadyFrame {
  type: 'ready'; protocolVersion: 1; connectionGeneration: string;
  agent: { teamId: string; slug: string; name: string; orgName?: string }; issuer: string;
}
export type RpcMethod = 'group_chat.send_message' | 'group_chat.history' | 'card.upsert' | 'card.cancel' | 'thread.activity';
export interface Challenge {
  challengeId: string; teamId: string; keyGeneration: number; nonce: string; expiresInSeconds: number;
}
export interface Lease { lease: string; expiresInSeconds: number; gatewayUrl: string; issuer: string }

export type ActivityState = 'idle' | 'waiting' | 'executing';
