/** Only transport routing belongs to the channel adapter; collaboration policy is server-owned. */
export const NIA_CHANNEL_INSTRUCTIONS = `Nia Teams channel routing
Messages arrive as <channel source="nia-teams" group_chat_id="..."> blocks. Multiple GroupChats share this session. You MUST call send_message with group_chat_id from the block to publish a reply; terminal text stays private. Pass group_chat_id to chat_history as well. Use keep_working: true for interim updates; omit keep_working on the final reply to transition to idle.`;
