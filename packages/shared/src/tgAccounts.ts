/**
 * Multi Telegram user-accounts routing.
 *
 * Env formats:
 *   TG_ACCOUNTS_JSON=[{"id":"mgr1","api_id":123,"api_hash":"...","session":"...","manager_user_id":111}]
 *   or classic single: TG_API_ID / TG_API_HASH / TG_STRING_SESSION (id=default)
 *
 * Chat sticky assignment stored via API deal.metadata.tg_account_id
 */

export interface TgAccountConfig {
  id: string;
  api_id: number;
  api_hash: string;
  session: string;
  /** Optional: Telegram user id of human manager owning this session */
  manager_user_id?: number;
  label?: string;
}

export function loadTgAccountsFromEnv(): TgAccountConfig[] {
  const raw = process.env.TG_ACCOUNTS_JSON?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as TgAccountConfig[];
      return parsed.filter((a) => a.id && a.api_id && a.api_hash && a.session);
    } catch {
      console.error("[tg-accounts] invalid TG_ACCOUNTS_JSON");
    }
  }
  const apiId = Number(process.env.TG_API_ID || 0);
  const apiHash = process.env.TG_API_HASH || "";
  const session = process.env.TG_STRING_SESSION || "";
  if (apiId && apiHash && session) {
    return [
      {
        id: process.env.TG_DEFAULT_ACCOUNT_ID || "default",
        api_id: apiId,
        api_hash: apiHash,
        session,
        label: "default",
      },
    ];
  }
  return [];
}

/** Round-robin picker with sticky map chatId -> accountId */
export class TgAccountRouter {
  private accounts: TgAccountConfig[];
  private sticky = new Map<number, string>();
  private rr = 0;

  constructor(accounts: TgAccountConfig[]) {
    this.accounts = accounts;
  }

  list() {
    return this.accounts.map(({ id, label, manager_user_id }) => ({
      id,
      label,
      manager_user_id,
    }));
  }

  get(accountId: string): TgAccountConfig | undefined {
    return this.accounts.find((a) => a.id === accountId);
  }

  assign(chatId: number, preferred?: string): TgAccountConfig | undefined {
    if (!this.accounts.length) return undefined;
    if (preferred) {
      const pref = this.get(preferred);
      if (pref) {
        this.sticky.set(chatId, pref.id);
        return pref;
      }
    }
    const existing = this.sticky.get(chatId);
    if (existing) {
      const acc = this.get(existing);
      if (acc) return acc;
    }
    const pick = this.accounts[this.rr % this.accounts.length];
    this.rr += 1;
    this.sticky.set(chatId, pick.id);
    return pick;
  }

  bind(chatId: number, accountId: string) {
    this.sticky.set(chatId, accountId);
  }
}
