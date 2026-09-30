/** Unique BullMQ job ids so retries / reconnects do not post twice. */
export function channelJobId(
  kind: string,
  ...parts: Array<string | number | undefined>
): string {
  return [kind, ...parts.map((p) => String(p ?? "0"))]
    .join("-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 128);
}

export function isJobExistsError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already exists/i.test(msg);
}

/** Direct user chats only — channels/groups are negative (or -100…). */
export function isPrivateUserChat(chatId: number): boolean {
  return Number.isFinite(chatId) && chatId > 0;
}

export function shouldIgnoreInbound(opts: {
  chatId: number;
  userId?: number;
  skipBotId?: number;
  blockedChatIds?: Array<string | number | undefined>;
}): boolean {
  if (!isPrivateUserChat(opts.chatId)) return true;
  if (
    opts.skipBotId &&
    (opts.chatId === opts.skipBotId || opts.userId === opts.skipBotId)
  ) {
    return true;
  }
  for (const id of opts.blockedChatIds || []) {
    if (id == null || id === "") continue;
    if (String(id) === String(opts.chatId)) return true;
    if (opts.userId != null && String(id) === String(opts.userId)) return true;
  }
  return false;
}
