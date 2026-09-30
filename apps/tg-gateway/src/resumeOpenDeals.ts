import type { TelegramClient } from "telegram";
import type { InboundMsg } from "./userClient";
import { catchUpChatSince } from "./unreadCatchUp";

export interface OpenTelegramDeal {
  id: string;
  tg_chat_id: number;
  client_name?: string | null;
  last_direction?: string | null;
  last_tg_message_id?: number | null;
  last_inbound_text?: string | null;
  needs_reply?: boolean;
  paused?: boolean;
  takeover?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchOpenTelegramDeals(apiBase: string): Promise<OpenTelegramDeal[]> {
  const token = (process.env.INTERNAL_API_TOKEN || "").trim();
  const headers: Record<string, string> = token ? { "x-internal-token": token } : {};
  const res = await fetch(`${apiBase}/deals/open/telegram`, { headers });
  if (!res.ok) {
    throw new Error(`open_deals_http_${res.status}`);
  }
  return (await res.json()) as OpenTelegramDeal[];
}

/** After restart: pull missed TG messages + re-process deals where client spoke last. */
export async function resumeOpenTelegramDeals(opts: {
  apiBase: string;
  client: TelegramClient;
  onInbound: (msg: InboundMsg) => Promise<void>;
  onResumeDeal: (deal: OpenTelegramDeal) => Promise<void>;
}): Promise<{ chats: number; tgMessages: number; resumed: number }> {
  let deals: OpenTelegramDeal[] = [];
  try {
    deals = await fetchOpenTelegramDeals(opts.apiBase);
  } catch (err) {
    console.warn("[tg-resume] fetch open deals failed", err);
    return { chats: 0, tgMessages: 0, resumed: 0 };
  }

  let tgMessages = 0;
  let resumed = 0;
  const seenChats = new Set<number>();

  for (const deal of deals) {
    const chatId = Number(deal.tg_chat_id);
    if (!Number.isFinite(chatId) || chatId <= 0) continue;
    if (deal.paused || deal.takeover) continue;

    if (!seenChats.has(chatId)) {
      seenChats.add(chatId);
      if (deal.last_tg_message_id && deal.last_tg_message_id > 0) {
        try {
          const n = await catchUpChatSince({
            client: opts.client,
            chatId,
            minMessageId: deal.last_tg_message_id,
            onInbound: opts.onInbound,
          });
          tgMessages += n;
        } catch (err) {
          console.warn("[tg-resume] chat catch-up failed", { chatId, err });
        }
        await sleep(500);
      }
    }

    if (deal.needs_reply && deal.last_inbound_text?.trim()) {
      try {
        await opts.onResumeDeal(deal);
        resumed += 1;
      } catch (err) {
        console.warn("[tg-resume] deal resume failed", { dealId: deal.id, err });
      }
      await sleep(400);
    }
  }

  return { chats: seenChats.size, tgMessages, resumed };
}
