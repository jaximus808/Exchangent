// Agent registry: the buyer agent and static sellers from the principals file, plus dynamic seller agents for
// self-serve businesses, minted on demand with the worker token (doc/signup-contract.md, "Agents").

import { BackendError } from "./backend.ts";
import type { SellerAgentToken } from "./backend.ts";
import type { BuyerPrincipal, Principals, SellerPrincipal } from "./config.ts";

export type AgentRole = "buyer" | "seller";

interface AgentBase {
  id: string;
  role: AgentRole;
  name: string;
  slug: string;
  token: string;
}

export interface BuyerAgent extends AgentBase {
  id: "buyer";
  role: "buyer";
  buyerId: string;
  /** true: negotiates every delegated order (buyer_agent token); false: only buyerId's orders. */
  platform: boolean;
}

export interface SellerAgent extends AgentBase {
  role: "seller";
  sellerId: string;
  /** Minted by the worker for a self-serve business (not in the principals file). */
  dynamic?: boolean;
  /** Dynamic agents: token expiry (ms since epoch). */
  expiresAt?: number;
}

export type Agent = BuyerAgent | SellerAgent;

export function slugify(s: string | null | undefined): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
}

export function buyerAgent(buyer: BuyerPrincipal): BuyerAgent {
  return {
    id: "buyer",
    role: "buyer",
    name: "Buyer agent",
    slug: "buyer",
    token: buyer.token,
    buyerId: buyer.actor_id,
    platform: buyer.scope === "buyer_agent",
  };
}

export function sellerAgent(seller: SellerPrincipal): SellerAgent {
  return {
    id: `seller:${seller.seller_id}`,
    role: "seller",
    name: seller.name || `Seller ${seller.seller_id}`,
    slug: slugify(seller.name) || `seller-${String(seller.seller_id).slice(0, 8)}`,
    token: seller.token,
    sellerId: seller.seller_id,
  };
}

/** Mints seller tokens for delegated businesses (WorkerApi.mintSellerToken). */
export interface SellerTokenMinter {
  mintSellerToken(sellerId: string, hours?: number): Promise<SellerAgentToken>;
}

/** resolveSeller result: an agent, or why this seller has none (the event is acked and skipped). */
export type SellerLookup = { agent: SellerAgent; skip?: undefined } | { skip: string; agent?: undefined };

/** Re-mint a dynamic seller token this long before it expires. */
export const REFRESH_BEFORE_MS = 10 * 60_000;

export class AgentRegistry {
  readPrincipals: (() => Principals) | undefined;
  minter: SellerTokenMinter | undefined;
  now: () => number = () => Date.now();
  #dynamic = new Map<string, SellerAgent>();
  #minting = new Map<string, Promise<SellerLookup>>();
  // Both are set by #load, which the constructor always calls.
  declare buyer: BuyerAgent;
  declare sellers: Map<string, SellerAgent>;

  /** @param readPrincipals re-read on unknown seller (the seed may have re-run) */
  constructor(principals: Principals, readPrincipals?: () => Principals, minter?: SellerTokenMinter) {
    this.readPrincipals = readPrincipals;
    this.minter = minter;
    this.#load(principals);
  }

  /** Called with each agent that appears after construction (principals file re-read). */
  onNew: ((agent: SellerAgent) => void) | null = null;

  #load(p: Principals): void {
    const before: Map<string, SellerAgent> | undefined = this.sellers;
    this.buyer = this.buyer || buyerAgent(p.buyer);
    this.sellers = new Map(
      p.sellers.map((s) => {
        const existing = before?.get(s.seller_id);
        if (existing) existing.token = s.token; // the seed may have rotated tokens
        return [s.seller_id, existing || sellerAgent(s)];
      }),
    );
    if (before && this.onNew) for (const [id, a] of this.sellers) if (!before.has(id)) this.onNew(a);
  }

  all(): Agent[] {
    return [this.buyer, ...this.sellers.values(), ...this.#dynamic.values()];
  }

  /** A known agent (static, else an already-minted dynamic one). Never mints. */
  seller(sellerId: string): SellerAgent | null {
    if (!this.sellers.has(sellerId) && !this.#dynamic.has(sellerId) && this.readPrincipals) {
      try { this.#load(this.readPrincipals()); } catch { /* keep the old registry */ }
    }
    return this.sellers.get(sellerId) || this.#dynamic.get(sellerId) || null;
  }

  /**
   * The agent for a seller: static from the principals file, else a dynamic agent minted with the worker token
   * (cached; re-minted 10 minutes before expiry, or now with `refresh`). `skip` when the business does not
   * delegate negotiation or does not exist. Other failures throw, so the dispatcher retries the event.
   */
  async resolveSeller(sellerId: string, { refresh = false }: { refresh?: boolean } = {}): Promise<SellerLookup | null> {
    const known = this.seller(sellerId);
    if (known && !known.dynamic) return { agent: known };
    if (known && !refresh && (known.expiresAt ?? 0) - this.now() > REFRESH_BEFORE_MS) return { agent: known };
    if (!this.minter) return null;
    if (!this.#minting.has(sellerId)) {
      const p = this.#mint(sellerId).finally(() => this.#minting.delete(sellerId));
      this.#minting.set(sellerId, p);
    }
    return this.#minting.get(sellerId)!; // set just above if missing
  }

  async #mint(sellerId: string): Promise<SellerLookup> {
    let t: SellerAgentToken;
    try {
      t = await this.minter!.mintSellerToken(sellerId); // resolveSeller checked minter
    } catch (err) {
      if (err instanceof BackendError && (err.code === "not_delegated" || err.code === "seller_not_found")) {
        this.#dynamic.delete(sellerId);
        return { skip: err.code === "not_delegated" ? "seller negotiates in chat (agent negotiation is off)" : `unknown seller ${sellerId}` };
      }
      throw err;
    }
    if (!t?.token) throw new Error(`worker minted no token for seller ${sellerId}`);
    const expiresAt = Date.parse(t.expires_at) || this.now() + 60 * 60_000;
    const existing = this.#dynamic.get(sellerId);
    if (existing) {
      existing.token = t.token;
      existing.expiresAt = expiresAt;
      return { agent: existing };
    }
    const agent: SellerAgent = { ...sellerAgent({ seller_id: sellerId, name: t.name, token: t.token }), dynamic: true, expiresAt };
    this.#dynamic.set(sellerId, agent);
    this.onNew?.(agent);
    return { agent };
  }
}
