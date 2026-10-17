// Agent registry built from the demo principals file. One buyer agent, one agent per seller.

export function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
}

export function buyerAgent(buyer) {
  return { id: "buyer", role: "buyer", name: "Buyer agent", slug: "buyer", token: buyer.token, buyerId: buyer.actor_id };
}

export function sellerAgent(seller) {
  return {
    id: `seller:${seller.seller_id}`,
    role: "seller",
    name: seller.name || `Seller ${seller.seller_id}`,
    slug: slugify(seller.name) || `seller-${String(seller.seller_id).slice(0, 8)}`,
    token: seller.token,
    sellerId: seller.seller_id,
  };
}

export class AgentRegistry {
  /** @param {() => object} readPrincipals re-read on unknown seller (the seed may have re-run) */
  constructor(principals, readPrincipals) {
    this.readPrincipals = readPrincipals;
    this.#load(principals);
  }

  /** Called with each agent that appears after construction (principals file re-read). */
  onNew = null;

  #load(p) {
    const before = this.sellers;
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

  all() {
    return [this.buyer, ...this.sellers.values()];
  }

  seller(sellerId) {
    if (!this.sellers.has(sellerId) && this.readPrincipals) {
      try { this.#load(this.readPrincipals()); } catch { /* keep the old registry */ }
    }
    return this.sellers.get(sellerId) || null;
  }
}
