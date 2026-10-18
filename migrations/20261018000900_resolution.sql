-- Resolution: order lifecycle, agent-negotiated remedies, refunds and chargebacks (doc/resolution-design.md,
-- doc/resolution-contract.md). Additive. Never re-creates commerce_apply_payment (migration 0800 owns it).
-- Resolution outbox rows use kind 'res:<event>:<to_role>' with a fresh aggregate per row. They have their own
-- worker feed (commerce_resolution_events) and ack, so the negotiation feed, the order receipt and older
-- runners are unchanged; a runner opts in with GET /worker/events?include=resolution.
-- Payloads carry IDs, kinds and amounts only: never budgets, floors or emails.

-- 0. Owned by 0800 (hardening); repeated so this migration also applies on its own.
ALTER TABLE public.commerce_orders ADD COLUMN IF NOT EXISTS stripe_payment_intent text;

-- 1. Order lifecycle: confirmed -> shipped -> delivered -> closed, or cancelled / refunded.
DO $$ DECLARE c text; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.commerce_orders'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) ~ '\mstatus\M' LOOP
  EXECUTE format('ALTER TABLE public.commerce_orders DROP CONSTRAINT %I',c);
 END LOOP;
END $$;
ALTER TABLE public.commerce_orders
 ADD CONSTRAINT commerce_orders_status_check CHECK(status IN ('confirmed','shipped','delivered','closed','cancelled','refunded')),
 ADD COLUMN refunded_cents integer NOT NULL DEFAULT 0 CHECK(refunded_cents >= 0),
 ADD COLUMN carrier text CHECK(length(carrier) BETWEEN 1 AND 80),
 ADD COLUMN tracking text CHECK(length(tracking) BETWEEN 1 AND 120),
 ADD COLUMN shipped_at timestamptz, ADD COLUMN delivered_at timestamptz,
 ADD COLUMN delivery_evidence jsonb CHECK(delivery_evidence IS NULL OR jsonb_typeof(delivery_evidence)='object'),
 ADD COLUMN dispute_window_ends_at timestamptz,
 ADD COLUMN replacements integer NOT NULL DEFAULT 0 CHECK(replacements >= 0);
CREATE INDEX IF NOT EXISTS commerce_orders_payment_intent_idx ON public.commerce_orders(stripe_payment_intent);
CREATE INDEX IF NOT EXISTS commerce_orders_buyer_idx ON public.commerce_orders(buyer_id, created_at);
CREATE INDEX IF NOT EXISTS commerce_orders_seller_idx ON public.commerce_orders(seller_id, created_at);

-- 2. Each seller's resolution policy. No row means the defaults (commerce_policy_row).
CREATE TABLE public.commerce_resolution_policies (
 seller_id uuid PRIMARY KEY REFERENCES public.commerce_sellers,
 auto_refund_not_received_after_days integer NOT NULL DEFAULT 3 CHECK(auto_refund_not_received_after_days BETWEEN 0 AND 60),
 max_auto_partial_refund_pct integer NOT NULL DEFAULT 15 CHECK(max_auto_partial_refund_pct BETWEEN 0 AND 100),
 return_window_days integer NOT NULL DEFAULT 14 CHECK(return_window_days BETWEEN 0 AND 365),
 restocking_fee_pct integer NOT NULL DEFAULT 0 CHECK(restocking_fee_pct BETWEEN 0 AND 50),
 seller_pays_return_shipping_when_at_fault boolean NOT NULL DEFAULT true,
 price_protection_days integer NOT NULL DEFAULT 0 CHECK(price_protection_days BETWEEN 0 AND 60),
 fight_chargebacks_above_cents integer NOT NULL DEFAULT 5000 CHECK(fight_chargebacks_above_cents >= 0),
 updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Cases: one remedy negotiation per problem. `remedy` is the proposal on the table (by remedy_by);
-- `resolution` is what was applied and how (auto | policy | agreed).
CREATE TABLE public.commerce_cases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL REFERENCES public.commerce_orders,
 request_id uuid NOT NULL REFERENCES public.commerce_requests,
 buyer_id uuid NOT NULL REFERENCES public.commerce_actors,
 seller_id uuid NOT NULL REFERENCES public.commerce_sellers,
 opened_by text NOT NULL CHECK(opened_by IN ('buyer','seller','platform')),
 type text NOT NULL CHECK(type IN ('not_received','not_as_described','damaged','missing_item','late','wrong_item','changed_mind',
  'duplicate_charge','substitution','address_problem')),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','escalated','closed')),
 turn text CHECK(turn IN ('buyer','seller')),
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 rounds integer NOT NULL DEFAULT 0 CHECK(rounds >= 0),
 items jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(items)='array'),
 description text CHECK(length(description) <= 1000),
 evidence jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(evidence)='array'),
 remedy jsonb CHECK(remedy IS NULL OR jsonb_typeof(remedy)='object'),
 remedy_by text CHECK(remedy_by IN ('buyer','seller')),
 resolution jsonb CHECK(resolution IS NULL OR jsonb_typeof(resolution)='object'),
 substitute_check jsonb,
 idempotency_key text CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(order_id, opened_by, idempotency_key)
);
-- At most one open case per order, so two remedies can never refund the same money twice.
CREATE UNIQUE INDEX commerce_cases_one_open ON public.commerce_cases(order_id) WHERE status='open';
CREATE INDEX commerce_cases_buyer ON public.commerce_cases(buyer_id, created_at);
CREATE INDEX commerce_cases_seller ON public.commerce_cases(seller_id, created_at);

CREATE TABLE public.commerce_case_moves (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 case_id uuid NOT NULL REFERENCES public.commerce_cases,
 by text NOT NULL CHECK(by IN ('buyer','seller','platform')),
 action text NOT NULL CHECK(action IN ('open','offer','accept','decline','auto','escalate','evidence','return_received')),
 remedy jsonb, note text CHECK(length(note) <= 500), version integer NOT NULL,
 idempotency_key text CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(case_id, idempotency_key)
);
CREATE INDEX commerce_case_moves_case ON public.commerce_case_moves(case_id, created_at);

-- 4. Refunds: executed by the backend through Stripe after the database decided them.
CREATE TABLE public.commerce_refunds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL REFERENCES public.commerce_orders,
 case_id uuid REFERENCES public.commerce_cases,
 amount_cents integer NOT NULL CHECK(amount_cents > 0),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 100),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed')),
 stripe_refund_id text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX commerce_refunds_one_per_case ON public.commerce_refunds(case_id) WHERE case_id IS NOT NULL;
CREATE INDEX commerce_refunds_order ON public.commerce_refunds(order_id);

-- 5. Bank disputes (chargebacks) reported by Stripe.
CREATE TABLE public.commerce_disputes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL REFERENCES public.commerce_orders,
 stripe_dispute_id text NOT NULL UNIQUE CHECK(length(stripe_dispute_id) BETWEEN 1 AND 200),
 reason text CHECK(length(reason) <= 100),
 amount_cents integer NOT NULL CHECK(amount_cents >= 0),
 status text NOT NULL CHECK(length(status) BETWEEN 1 AND 60),
 decision text CHECK(decision IN ('fight','accept')),
 evidence jsonb, submitted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- helpers ----------

-- A date string or NULL (never an error): requirements.deliver_by is free-form JSON.
CREATE FUNCTION public.commerce_try_date(p text)
RETURNS date LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF p IS NULL OR p !~ '^\d{4}-\d{2}-\d{2}' THEN RETURN NULL; END IF;
 RETURN left(p,10)::date;
EXCEPTION WHEN others THEN RETURN NULL;
END $$;

-- The promised delivery deadline: the request deadline, else the end of requirements.deliver_by (UTC).
CREATE FUNCTION public.commerce_order_deadline(p_order uuid)
RETURNS timestamptz LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT coalesce(q.deadline,
  (public.commerce_try_date(q.structured_requirements->>'deliver_by') + 1)::timestamp AT TIME ZONE 'UTC')
 FROM public.commerce_orders o JOIN public.commerce_reservations r ON r.id=o.reservation_id
 JOIN public.commerce_requests q ON q.id=r.request_id WHERE o.id=p_order
$$;

CREATE FUNCTION public.commerce_policy_row(p_seller uuid)
RETURNS public.commerce_resolution_policies LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE p public.commerce_resolution_policies;
BEGIN
 SELECT * INTO p FROM public.commerce_resolution_policies WHERE seller_id=p_seller;
 IF NOT FOUND THEN
  p.seller_id := p_seller; p.auto_refund_not_received_after_days := 3; p.max_auto_partial_refund_pct := 15;
  p.return_window_days := 14; p.restocking_fee_pct := 0; p.seller_pays_return_shipping_when_at_fault := true;
  p.price_protection_days := 0; p.fight_chargebacks_above_cents := 5000; p.updated_at := now();
 END IF;
 RETURN p;
END $$;

CREATE FUNCTION public.commerce_get_policy(p_seller uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT to_jsonb(p) - 'updated_at' FROM public.commerce_policy_row(p_seller) p
$$;

-- Owner-only policy change. Integers must be whole numbers in range; unknown keys are rejected.
CREATE FUNCTION public.commerce_set_policy(p_seller uuid, p_patch jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur public.commerce_resolution_policies; k text; v jsonb;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.commerce_sellers WHERE id=p_seller) THEN RAISE EXCEPTION 'seller_not_found'; END IF;
 IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN RAISE EXCEPTION 'invalid_input'; END IF;
 FOR k, v IN SELECT * FROM jsonb_each(p_patch) LOOP
  IF k = 'seller_pays_return_shipping_when_at_fault' THEN
   IF jsonb_typeof(v) <> 'boolean' THEN RAISE EXCEPTION 'invalid_input'; END IF;
  ELSIF k IN ('auto_refund_not_received_after_days','max_auto_partial_refund_pct','return_window_days','restocking_fee_pct',
    'price_protection_days','fight_chargebacks_above_cents') THEN
   IF jsonb_typeof(v) <> 'number' OR v::numeric <> trunc(v::numeric) OR v::numeric > 2147483647 THEN RAISE EXCEPTION 'invalid_input'; END IF;
  ELSE RAISE EXCEPTION 'invalid_input';
  END IF;
 END LOOP;
 cur := jsonb_populate_record(public.commerce_policy_row(p_seller), p_patch);
 BEGIN
  INSERT INTO public.commerce_resolution_policies SELECT (cur).*
  ON CONFLICT(seller_id) DO UPDATE SET auto_refund_not_received_after_days=EXCLUDED.auto_refund_not_received_after_days,
   max_auto_partial_refund_pct=EXCLUDED.max_auto_partial_refund_pct, return_window_days=EXCLUDED.return_window_days,
   restocking_fee_pct=EXCLUDED.restocking_fee_pct,
   seller_pays_return_shipping_when_at_fault=EXCLUDED.seller_pays_return_shipping_when_at_fault,
   price_protection_days=EXCLUDED.price_protection_days, fight_chargebacks_above_cents=EXCLUDED.fight_chargebacks_above_cents,
   updated_at=now();
 EXCEPTION WHEN check_violation THEN RAISE EXCEPTION 'invalid_input';
 END;
 RETURN public.commerce_get_policy(p_seller);
END $$;

-- Who an actor is on an order: 'buyer' (the buyer, or the platform buyer agent on a delegated request)
-- or 'seller' (the selling business). Anything else is forbidden.
CREATE FUNCTION public.commerce_order_role(p_order uuid, p_actor uuid, p_scope text, p_seller uuid)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o public.commerce_orders; delegated boolean;
BEGIN
 SELECT * INTO o FROM public.commerce_orders WHERE id=p_order;
 IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
 IF p_scope='buyer' AND o.buyer_id=p_actor THEN RETURN 'buyer'; END IF;
 IF p_scope='seller' AND o.seller_id=p_seller THEN RETURN 'seller'; END IF;
 IF p_scope='buyer_agent' THEN
  SELECT q.delegate_negotiation INTO delegated FROM public.commerce_reservations r
  JOIN public.commerce_requests q ON q.id=r.request_id WHERE r.id=o.reservation_id;
  IF delegated THEN RETURN 'buyer'; END IF;
 END IF;
 RAISE EXCEPTION 'forbidden';
END $$;

-- Money still refundable: the total minus refunds that are pending or done.
CREATE FUNCTION public.commerce_refundable(p_order uuid)
RETURNS integer LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT greatest(o.total_cents - coalesce((SELECT sum(f.amount_cents) FROM public.commerce_refunds f
  WHERE f.order_id=o.id AND f.status IN ('pending','succeeded')),0),0)::integer
 FROM public.commerce_orders o WHERE o.id=p_order
$$;

-- The order's reserved line snapshots (what the buyer paid for, per item).
CREATE FUNCTION public.commerce_order_items(p_order uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('inventory_id',ri.inventory_id,'title',ri.title,'quantity',ri.quantity,
  'unit_cents',ri.unit_cents,'category',i.category) ORDER BY ri.title, ri.inventory_id),'[]'::jsonb)
 FROM public.commerce_orders o JOIN public.commerce_reservation_items ri ON ri.reservation_id=o.reservation_id
 JOIN public.commerce_inventory i ON i.id=ri.inventory_id WHERE o.id=p_order
$$;

-- Validate a list of {inventory_id, quantity?} against the order's lines. Empty or NULL means none given.
CREATE FUNCTION public.commerce_case_items(p_order uuid, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE e jsonb; line record; out jsonb := '[]'; q integer; seen text[] := '{}';
BEGIN
 IF p_items IS NULL OR p_items = 'null'::jsonb THEN RETURN '[]'; END IF;
 IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 20 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 FOR e IN SELECT * FROM jsonb_array_elements(p_items) LOOP
  IF jsonb_typeof(e) <> 'object' OR jsonb_typeof(e->'inventory_id') <> 'string' THEN RAISE EXCEPTION 'invalid_input'; END IF;
  IF (e->>'inventory_id') = ANY(seen) THEN RAISE EXCEPTION 'invalid_input'; END IF;
  seen := seen || (e->>'inventory_id');
  SELECT ri.inventory_id, ri.title, ri.quantity, ri.unit_cents INTO line
  FROM public.commerce_orders o JOIN public.commerce_reservation_items ri ON ri.reservation_id=o.reservation_id
  WHERE o.id=p_order AND ri.inventory_id::text=lower(e->>'inventory_id');
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_in_order'; END IF;
  IF e ? 'quantity' AND e->'quantity' <> 'null'::jsonb THEN
   IF jsonb_typeof(e->'quantity') <> 'number' OR (e->>'quantity')::numeric <> trunc((e->>'quantity')::numeric) THEN RAISE EXCEPTION 'invalid_input'; END IF;
   q := (e->>'quantity')::integer;
   IF q < 1 OR q > line.quantity THEN RAISE EXCEPTION 'invalid_input'; END IF;
  ELSE q := line.quantity; END IF;
  out := out || jsonb_build_array(jsonb_build_object('inventory_id',line.inventory_id,'title',line.title,'quantity',q,'unit_cents',line.unit_cents));
 END LOOP;
 RETURN out;
END $$;

CREATE FUNCTION public.commerce_items_value(p_items jsonb)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT coalesce(sum((e->>'quantity')::bigint * (e->>'unit_cents')::bigint),0)::integer FROM jsonb_array_elements(p_items) e
$$;

-- Normalize a proposed remedy for a case: validate the shape, compute amount_cents from the order (never
-- trust a client total), and cap every amount at what is still refundable. Raises invalid_input.
CREATE FUNCTION public.commerce_norm_remedy(p_case uuid, p_remedy jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.commerce_cases; o public.commerce_orders; refundable integer; kind text; amount integer; items jsonb;
 sub jsonb; pol public.commerce_resolution_policies; delivery integer; payer text; out jsonb;
BEGIN
 IF p_remedy IS NULL OR jsonb_typeof(p_remedy) <> 'object' OR jsonb_typeof(p_remedy->'kind') <> 'string' THEN RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO c FROM public.commerce_cases WHERE id=p_case;
 SELECT * INTO o FROM public.commerce_orders WHERE id=c.order_id;
 refundable := public.commerce_refundable(o.id);
 pol := public.commerce_policy_row(o.seller_id);
 kind := p_remedy->>'kind';
 -- A replacement moves no money (its stored remedy carries amount_cents 0), so only money remedies are checked.
 IF kind <> 'replace' AND p_remedy ? 'amount_cents' AND p_remedy->'amount_cents' <> 'null'::jsonb AND (jsonb_typeof(p_remedy->'amount_cents') <> 'number'
   OR (p_remedy->>'amount_cents')::numeric <> trunc((p_remedy->>'amount_cents')::numeric) OR (p_remedy->>'amount_cents')::numeric < 1
   OR (p_remedy->>'amount_cents')::numeric > 2147483647) THEN RAISE EXCEPTION 'invalid_input'; END IF;
 amount := (p_remedy->>'amount_cents')::integer;
 items := public.commerce_case_items(o.id, p_remedy->'items');
 IF jsonb_array_length(items) = 0 THEN items := public.commerce_case_items(o.id, c.items); END IF;
 SELECT f.delivery_cents INTO delivery FROM public.commerce_reservations r JOIN public.commerce_offers f ON f.id=r.offer_id
 WHERE r.id=o.reservation_id;
 IF kind = 'refund_full' THEN
  out := jsonb_build_object('kind',kind,'amount_cents',refundable);
 ELSIF kind IN ('refund_partial','keep_with_discount') THEN
  IF amount IS NULL THEN RAISE EXCEPTION 'invalid_input'; END IF;
  out := jsonb_build_object('kind',kind,'amount_cents',least(amount,refundable));
 ELSIF kind = 'sla_credit' THEN
  out := jsonb_build_object('kind',kind,'amount_cents',least(coalesce(amount,delivery),refundable));
 ELSIF kind = 'refund_items' THEN
  IF jsonb_array_length(items) = 0 THEN items := public.commerce_order_items(o.id); END IF;
  out := jsonb_build_object('kind',kind,'items',items,'amount_cents',least(public.commerce_items_value(items),refundable));
 ELSIF kind = 'return_for_refund' THEN
  IF jsonb_array_length(items) = 0 THEN items := public.commerce_order_items(o.id); END IF;
  payer := coalesce(p_remedy->>'return_shipping_paid_by',
   CASE WHEN c.type IN ('not_as_described','damaged','wrong_item') AND pol.seller_pays_return_shipping_when_at_fault
    THEN 'seller' ELSE 'buyer' END);
  IF payer NOT IN ('buyer','seller') THEN RAISE EXCEPTION 'invalid_input'; END IF;
  amount := public.commerce_items_value(items);
  IF c.type = 'changed_mind' THEN amount := amount - (amount * pol.restocking_fee_pct / 100); END IF;
  out := jsonb_build_object('kind',kind,'items',items,'return_shipping_paid_by',payer,
   'amount_cents',least(amount,refundable),'restocking_fee_pct',CASE WHEN c.type='changed_mind' THEN pol.restocking_fee_pct ELSE 0 END);
 ELSIF kind = 'replace' THEN
  sub := p_remedy->'substitute';
  IF sub IS NOT NULL AND sub <> 'null'::jsonb THEN
   -- Only the substitute already on the table (from report_fulfilment_issue) can be accepted or re-proposed.
   IF c.remedy IS NULL OR c.remedy->'substitute' IS NULL OR (c.remedy->'substitute'->>'inventory_id') IS DISTINCT FROM (sub->>'inventory_id') THEN
    RAISE EXCEPTION 'invalid_input'; END IF;
   out := c.remedy;
  ELSE
   IF jsonb_array_length(items) = 0 THEN items := public.commerce_order_items(o.id); END IF;
   out := jsonb_build_object('kind',kind,'items',items,'amount_cents',0);
  END IF;
 ELSIF kind = 'cancel' THEN
  IF o.status <> 'confirmed' THEN RAISE EXCEPTION 'already_shipped'; END IF;
  out := jsonb_build_object('kind',kind,'amount_cents',refundable);
 ELSE
  RAISE EXCEPTION 'invalid_input';
 END IF;
 IF p_remedy ? 'note' AND jsonb_typeof(p_remedy->'note')='string' THEN out := out || jsonb_build_object('note',left(p_remedy->>'note',500)); END IF;
 RETURN out;
END $$;

-- Queue a resolution event for the runner: 'res:<event>:<to_role>' with a fresh aggregate.
CREATE FUNCTION public.commerce_res_event(p_event text, p_to text, p_payload jsonb)
RETURNS void LANGUAGE sql SET search_path = pg_catalog, public, pg_temp AS $$
 INSERT INTO public.commerce_outbox(kind,aggregate_id,payload) VALUES('res:'||p_event||':'||p_to, gen_random_uuid(), p_payload)
$$;

CREATE FUNCTION public.commerce_case_payload(p_case uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT jsonb_strip_nulls(jsonb_build_object('case_id',c.id,'order_id',c.order_id,'request_id',c.request_id,'seller_id',c.seller_id,
  'type',c.type,'status',c.status,'turn',c.turn,'version',c.version,'opened_by',c.opened_by,
  'remedy_kind',coalesce(c.resolution->>'kind',c.remedy->>'kind'),
  'amount_cents',(coalesce(c.resolution,c.remedy)->>'amount_cents')::integer,'title',q.title))
 FROM public.commerce_cases c JOIN public.commerce_requests q ON q.id=c.request_id WHERE c.id=p_case
$$;

CREATE FUNCTION public.commerce_order_payload(p_order uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT jsonb_strip_nulls(jsonb_build_object('order_id',o.id,'request_id',r.request_id,'seller_id',o.seller_id,'seller_name',sl.name,
  'status',o.status,'total_cents',o.total_cents,'carrier',o.carrier,'tracking',o.tracking,'title',q.title))
 FROM public.commerce_orders o JOIN public.commerce_reservations r ON r.id=o.reservation_id
 JOIN public.commerce_requests q ON q.id=r.request_id JOIN public.commerce_sellers sl ON sl.id=o.seller_id WHERE o.id=p_order
$$;

-- ---------- reads ----------

CREATE FUNCTION public.commerce_order_json(p_order uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT jsonb_build_object('order_id',o.id,'request_id',r.request_id,'title',q.title,'seller_id',o.seller_id,'seller_name',sl.name,
  'status',o.status,'total_cents',o.total_cents,'refunded_cents',o.refunded_cents,'refundable_cents',public.commerce_refundable(o.id),
  'currency',o.currency,'created_at',o.created_at,'shipped_at',o.shipped_at,'delivered_at',o.delivered_at,'carrier',o.carrier,
  'tracking',o.tracking,'delivery_evidence',o.delivery_evidence,'dispute_window_ends_at',o.dispute_window_ends_at,
  'deliver_by',public.commerce_order_deadline(o.id),'delivery_cents',f.delivery_cents,'tax_cents',f.tax_cents,
  'items',public.commerce_order_items(o.id),
  'cases',(SELECT coalesce(jsonb_agg(jsonb_build_object('case_id',c.id,'type',c.type,'status',c.status,'opened_by',c.opened_by,
    'turn',c.turn,'version',c.version,'updated_at',c.updated_at) ORDER BY c.created_at, c.id),'[]'::jsonb)
   FROM public.commerce_cases c WHERE c.order_id=o.id),
  'refunds',(SELECT coalesce(jsonb_agg(jsonb_build_object('refund_id',x.id,'amount_cents',x.amount_cents,'status',x.status,
    'reason',x.reason,'case_id',x.case_id,'created_at',x.created_at) ORDER BY x.created_at, x.id),'[]'::jsonb)
   FROM public.commerce_refunds x WHERE x.order_id=o.id),
  'disputes',(SELECT coalesce(jsonb_agg(jsonb_build_object('dispute_id',d.id,'status',d.status,'reason',d.reason,
    'amount_cents',d.amount_cents,'decision',d.decision,'submitted_at',d.submitted_at) ORDER BY d.created_at, d.id),'[]'::jsonb)
   FROM public.commerce_disputes d WHERE d.order_id=o.id))
 FROM public.commerce_orders o JOIN public.commerce_reservations r ON r.id=o.reservation_id
 JOIN public.commerce_requests q ON q.id=r.request_id JOIN public.commerce_sellers sl ON sl.id=o.seller_id
 JOIN public.commerce_offers f ON f.id=r.offer_id WHERE o.id=p_order
$$;

CREATE FUNCTION public.commerce_buyer_orders(p_buyer uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT coalesce(jsonb_agg(public.commerce_order_json(x.id) ORDER BY x.created_at DESC, x.id),'[]'::jsonb)
 FROM (SELECT o.id, o.created_at FROM public.commerce_orders o WHERE o.buyer_id=p_buyer ORDER BY o.created_at DESC, o.id LIMIT 50) x
$$;

-- The seller's orders. The buyer appears only as a placeholder name: no email or account ID.
CREATE FUNCTION public.commerce_seller_orders(p_seller uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT coalesce(jsonb_agg(public.commerce_order_json(x.id) || jsonb_build_object('shipping_name','Buyer')
  ORDER BY x.created_at DESC, x.id),'[]'::jsonb)
 FROM (SELECT o.id, o.created_at FROM public.commerce_orders o WHERE o.seller_id=p_seller ORDER BY o.created_at DESC, o.id LIMIT 50) x
$$;

-- One case for either party. The seller's policy is included; the backend strips it from buyer views.
CREATE FUNCTION public.commerce_case_json(p_case uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT jsonb_build_object('case_id',c.id,'order_id',c.order_id,'request_id',c.request_id,'seller_id',c.seller_id,'seller_name',sl.name,
  'title',q.title,'type',c.type,'opened_by',c.opened_by,'status',c.status,'turn',c.turn,'version',c.version,'rounds',c.rounds,
  'items',c.items,'description',c.description,'evidence',c.evidence,'remedy',c.remedy,'remedy_by',c.remedy_by,
  'resolution',c.resolution,'substitute_check',c.substitute_check,'created_at',c.created_at,'updated_at',c.updated_at,
  'requested_remedy',(SELECT m.remedy FROM public.commerce_case_moves m WHERE m.case_id=c.id AND m.action='open' LIMIT 1),
  'total_cents',o.total_cents,'refunded_cents',o.refunded_cents,'refundable_cents',public.commerce_refundable(o.id),
  'order',jsonb_build_object('status',o.status,'total_cents',o.total_cents,'refunded_cents',o.refunded_cents,
   'refundable_cents',public.commerce_refundable(o.id),'shipped_at',o.shipped_at,'delivered_at',o.delivered_at,
   'carrier',o.carrier,'tracking',o.tracking,'delivery_evidence',o.delivery_evidence,'deliver_by',public.commerce_order_deadline(o.id),
   'items',public.commerce_order_items(o.id)),
  'moves',(SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('by',m.by,'action',m.action,'remedy',m.remedy,'note',m.note,
    'version',m.version,'at',m.created_at)) ORDER BY m.created_at, m.version, m.id),'[]'::jsonb)
   FROM public.commerce_case_moves m WHERE m.case_id=c.id),
  'refunds',(SELECT coalesce(jsonb_agg(jsonb_build_object('refund_id',x.id,'amount_cents',x.amount_cents,'status',x.status,
    'reason',x.reason,'created_at',x.created_at) ORDER BY x.created_at, x.id),'[]'::jsonb)
   FROM public.commerce_refunds x WHERE x.case_id=c.id),
  'policy',public.commerce_get_policy(c.seller_id) - 'seller_id')
 FROM public.commerce_cases c JOIN public.commerce_orders o ON o.id=c.order_id
 JOIN public.commerce_requests q ON q.id=c.request_id JOIN public.commerce_sellers sl ON sl.id=c.seller_id WHERE c.id=p_case
$$;

-- What a money-moving call returns: the case plus the refunds the backend must now execute through Stripe.
CREATE FUNCTION public.commerce_case_result(p_case uuid, p_refunds jsonb)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT public.commerce_case_json(p_case) || jsonb_build_object('refunds_to_execute',coalesce(p_refunds,'[]'::jsonb))
$$;

CREATE FUNCTION public.commerce_cases_for(p_actor uuid, p_scope text, p_seller uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT coalesce(jsonb_agg(public.commerce_case_json(x.id) ORDER BY x.created_at DESC, x.id),'[]'::jsonb)
 FROM (SELECT c.id, c.created_at FROM public.commerce_cases c
  WHERE (p_scope='buyer' AND c.buyer_id=p_actor) OR (p_scope='seller' AND c.seller_id=p_seller)
  ORDER BY c.created_at DESC, c.id LIMIT 50) x
$$;

CREATE FUNCTION public.commerce_case_role(p_case uuid, p_actor uuid, p_scope text, p_seller uuid)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.commerce_cases;
BEGIN
 SELECT * INTO c FROM public.commerce_cases WHERE id=p_case;
 IF NOT FOUND THEN RAISE EXCEPTION 'case_not_found'; END IF;
 RETURN public.commerce_order_role(c.order_id, p_actor, p_scope, p_seller);
END $$;

-- ---------- applying a remedy ----------

-- Swap an order line for the agreed substitute. The line keeps the price the buyer paid (so receipts still
-- add up); a cheaper substitute is refunded as the difference.
CREATE FUNCTION public.commerce_swap_substitute(p_order uuid, p_sub jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o public.commerce_orders; line public.commerce_reservation_items; s public.commerce_inventory; q integer;
BEGIN
 SELECT * INTO o FROM public.commerce_orders WHERE id=p_order FOR UPDATE;
 SELECT * INTO line FROM public.commerce_reservation_items WHERE reservation_id=o.reservation_id
  AND inventory_id=(p_sub->>'replaces')::uuid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'item_not_in_order'; END IF;
 SELECT * INTO s FROM public.commerce_inventory WHERE id=(p_sub->>'inventory_id')::uuid FOR UPDATE;
 q := line.quantity;
 IF s.available < q THEN RAISE EXCEPTION 'out_of_stock'; END IF;
 UPDATE public.commerce_inventory SET available=available-q, sold=sold+q WHERE id=s.id;
 UPDATE public.commerce_inventory SET sold=greatest(sold-q,0) WHERE id=line.inventory_id;
 DELETE FROM public.commerce_reservation_items WHERE reservation_id=o.reservation_id AND inventory_id=line.inventory_id;
 INSERT INTO public.commerce_reservation_items(reservation_id,inventory_id,title,quantity,unit_cents)
 VALUES(o.reservation_id, s.id, s.title, q, line.unit_cents);
END $$;

-- Resolve a case with a remedy (already normalized). Returns the refunds the backend must execute now.
CREATE FUNCTION public.commerce_apply_remedy(p_case uuid, p_remedy jsonb, p_how text, p_by text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.commerce_cases; o public.commerce_orders; kind text; amount integer; e jsonb; refunds jsonb := '[]'; f public.commerce_refunds;
BEGIN
 SELECT * INTO c FROM public.commerce_cases WHERE id=p_case FOR UPDATE;
 SELECT * INTO o FROM public.commerce_orders WHERE id=c.order_id FOR UPDATE;
 kind := p_remedy->>'kind';
 amount := least(coalesce((p_remedy->>'amount_cents')::integer,0), public.commerce_refundable(o.id));
 IF kind = 'cancel' THEN
  IF o.status <> 'confirmed' THEN RAISE EXCEPTION 'already_shipped'; END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(public.commerce_order_items(o.id)) LOOP
   UPDATE public.commerce_inventory SET available=available+(e->>'quantity')::integer,
    sold=greatest(sold-(e->>'quantity')::integer,0) WHERE id=(e->>'inventory_id')::uuid;
  END LOOP;
  UPDATE public.commerce_orders SET status='cancelled' WHERE id=o.id;
 ELSIF kind = 'replace' THEN
  IF p_remedy->'substitute' IS NOT NULL THEN
   PERFORM public.commerce_swap_substitute(o.id, p_remedy->'substitute');
  ELSE
   FOR e IN SELECT * FROM jsonb_array_elements(p_remedy->'items') LOOP
    UPDATE public.commerce_inventory SET available=available-(e->>'quantity')::integer, sold=sold+(e->>'quantity')::integer
    WHERE id=(e->>'inventory_id')::uuid AND available >= (e->>'quantity')::integer;
    IF NOT FOUND THEN RAISE EXCEPTION 'out_of_stock'; END IF;
   END LOOP;
  END IF;
  -- A replacement ships again: back to confirmed, so mark_shipped applies to the new parcel.
  UPDATE public.commerce_orders SET status='confirmed', replacements=replacements+1 WHERE id=o.id AND status IN ('confirmed','shipped','delivered');
 END IF;
 -- Money now, except a return (refunded when the seller confirms it came back).
 IF kind IN ('refund_full','refund_partial','refund_items','keep_with_discount','sla_credit','cancel','replace') AND amount > 0 THEN
  INSERT INTO public.commerce_refunds(order_id,case_id,amount_cents,reason) VALUES(o.id,c.id,amount,kind) RETURNING * INTO f;
  refunds := jsonb_build_array(jsonb_build_object('refund_id',f.id,'amount_cents',f.amount_cents));
 END IF;
 UPDATE public.commerce_cases SET status='resolved', turn=NULL, version=version+1, remedy=NULL, remedy_by=NULL,
  resolution=(p_remedy || jsonb_build_object('amount_cents',amount,'how',p_how,'by',p_by,'at',now())), updated_at=now()
 WHERE id=c.id RETURNING * INTO c;
 INSERT INTO public.commerce_case_moves(case_id,by,action,remedy,version)
 VALUES(c.id,p_by,CASE WHEN p_how='agreed' THEN 'accept' ELSE 'auto' END,p_remedy || jsonb_build_object('amount_cents',amount),c.version);
 PERFORM public.commerce_res_event('case.resolved','buyer',public.commerce_case_payload(c.id));
 PERFORM public.commerce_res_event('case.resolved','seller',public.commerce_case_payload(c.id));
 RETURN refunds;
END $$;

CREATE FUNCTION public.commerce_escalate_case(p_case uuid, p_by text, p_note text)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.commerce_cases;
BEGIN
 UPDATE public.commerce_cases SET status='escalated', turn=NULL, version=version+1, updated_at=now() WHERE id=p_case RETURNING * INTO c;
 INSERT INTO public.commerce_case_moves(case_id,by,action,note,version) VALUES(c.id,p_by,'escalate',left(p_note,500),c.version);
 PERFORM public.commerce_res_event('case.escalated','buyer',public.commerce_case_payload(c.id));
 PERFORM public.commerce_res_event('case.escalated','seller',public.commerce_case_payload(c.id));
END $$;

-- Evidence entries: {kind: photo|measurement|text|tracking, ref} -> stamped with who and when.
CREATE FUNCTION public.commerce_norm_evidence(p_evidence jsonb, p_by text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE e jsonb; out jsonb := '[]';
BEGIN
 IF p_evidence IS NULL OR p_evidence = 'null'::jsonb THEN RETURN '[]'; END IF;
 IF jsonb_typeof(p_evidence) = 'object' THEN p_evidence := jsonb_build_array(p_evidence); END IF;
 IF jsonb_typeof(p_evidence) <> 'array' OR jsonb_array_length(p_evidence) > 10 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 FOR e IN SELECT * FROM jsonb_array_elements(p_evidence) LOOP
  IF jsonb_typeof(e) <> 'object' OR (e->>'kind') NOT IN ('photo','measurement','text','tracking')
    OR jsonb_typeof(e->'ref') <> 'string' OR length(e->>'ref') NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'invalid_input'; END IF;
  out := out || jsonb_build_array(jsonb_build_object('kind',e->>'kind','ref',e->>'ref','by',p_by,'at',now()));
 END LOOP;
 RETURN out;
END $$;

-- ---------- buyer: open a case ----------

-- Opens a case and first applies the automatic rules (verified facts or the seller's own policy):
--  not_received  no delivery recorded and the promise (+ policy days) has passed -> refund the items
--  late          delivered after the promised deadline -> delivery-fee credit
--  duplicate_charge another paid order, same buyer/seller/total within 10 minutes -> refund the newer
--  changed_mind  not shipped -> cancel; outside the return window -> declined; else return for a refund
--  a requested partial refund within the seller's auto-approve percentage -> accepted under policy
-- Otherwise the case opens with the seller to respond.
CREATE FUNCTION public.commerce_open_case(p_actor uuid, p_scope text, p_order uuid, p_type text, p_items jsonb,
 p_description text, p_evidence jsonb, p_requested_remedy jsonb, p_key text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o public.commerce_orders; c public.commerce_cases; role text; pol public.commerce_resolution_policies; deadline timestamptz;
 items jsonb; rem jsonb; how text; refunds jsonb := '[]'; other public.commerce_orders; f public.commerce_refunds; requested jsonb;
 req_id uuid; delivery integer; e jsonb;
BEGIN
 role := public.commerce_order_role(p_order, p_actor, p_scope, NULL);
 IF role <> 'buyer' OR p_scope <> 'buyer' THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF p_key IS NOT NULL THEN
  SELECT * INTO c FROM public.commerce_cases WHERE order_id=p_order AND opened_by='buyer' AND idempotency_key=p_key;
  IF FOUND THEN RETURN public.commerce_case_result(c.id,'[]'); END IF;
 END IF;
 IF p_type IS NULL OR p_type NOT IN ('not_received','not_as_described','damaged','missing_item','late','wrong_item','changed_mind','duplicate_charge') THEN
  RAISE EXCEPTION 'invalid_input'; END IF;
 IF p_description IS NOT NULL AND length(p_description) > 1000 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO o FROM public.commerce_orders WHERE id=p_order FOR UPDATE;
 IF o.status IN ('cancelled','refunded') OR public.commerce_refundable(o.id) = 0 THEN RAISE EXCEPTION 'order_closed'; END IF;
 IF EXISTS (SELECT 1 FROM public.commerce_cases WHERE order_id=o.id AND status='open') THEN RAISE EXCEPTION 'case_already_open'; END IF;
 items := public.commerce_case_items(o.id, p_items);
 SELECT r.request_id INTO req_id FROM public.commerce_reservations r WHERE r.id=o.reservation_id;
 INSERT INTO public.commerce_cases(order_id,request_id,buyer_id,seller_id,opened_by,type,turn,items,description,evidence,idempotency_key)
 VALUES(o.id,req_id,o.buyer_id,o.seller_id,'buyer',p_type,'seller',items,p_description,public.commerce_norm_evidence(p_evidence,'buyer'),p_key)
 RETURNING * INTO c;
 IF p_requested_remedy IS NOT NULL AND p_requested_remedy <> 'null'::jsonb THEN requested := public.commerce_norm_remedy(c.id, p_requested_remedy); END IF;
 INSERT INTO public.commerce_case_moves(case_id,by,action,remedy,note,version) VALUES(c.id,'buyer','open',requested,left(p_description,500),1);
 pol := public.commerce_policy_row(o.seller_id);
 deadline := public.commerce_order_deadline(o.id);
 SELECT f2.delivery_cents INTO delivery FROM public.commerce_reservations r JOIN public.commerce_offers f2 ON f2.id=r.offer_id WHERE r.id=o.reservation_id;

 IF p_type='not_received' AND o.delivered_at IS NULL
   AND now() > coalesce(deadline, o.shipped_at, o.created_at) + make_interval(days => pol.auto_refund_not_received_after_days) THEN
  rem := public.commerce_norm_remedy(c.id, CASE WHEN jsonb_array_length(items)=0 THEN '{"kind":"refund_full"}'::jsonb
   ELSE jsonb_build_object('kind','refund_items','items',items) END); how := 'auto';
 ELSIF p_type='late' AND o.delivered_at IS NOT NULL AND deadline IS NOT NULL AND o.delivered_at > deadline AND coalesce(delivery,0) > 0 THEN
  rem := public.commerce_norm_remedy(c.id, jsonb_build_object('kind','sla_credit','amount_cents',delivery)); how := 'auto';
 ELSIF p_type='duplicate_charge' THEN
  SELECT * INTO other FROM public.commerce_orders x WHERE x.id<>o.id AND x.buyer_id=o.buyer_id AND x.seller_id=o.seller_id
   AND x.total_cents=o.total_cents AND abs(extract(epoch FROM x.created_at-o.created_at)) <= 600
   AND x.status NOT IN ('cancelled','refunded') ORDER BY abs(extract(epoch FROM x.created_at-o.created_at)), x.created_at, x.id LIMIT 1;
  IF FOUND THEN
   -- Refund and cancel the newer of the two, whichever the buyer opened the case on.
   IF other.created_at > o.created_at OR (other.created_at = o.created_at AND other.id > o.id) THEN o := other; END IF;
   SELECT * INTO o FROM public.commerce_orders WHERE id=o.id FOR UPDATE;
   FOR e IN SELECT * FROM jsonb_array_elements(public.commerce_order_items(o.id)) LOOP
    UPDATE public.commerce_inventory SET available=available+(e->>'quantity')::integer,
     sold=greatest(sold-(e->>'quantity')::integer,0) WHERE id=(e->>'inventory_id')::uuid;
   END LOOP;
   UPDATE public.commerce_orders SET status='cancelled' WHERE id=o.id;
   IF public.commerce_refundable(o.id) > 0 THEN
    INSERT INTO public.commerce_refunds(order_id,case_id,amount_cents,reason)
    VALUES(o.id,c.id,public.commerce_refundable(o.id),'duplicate_charge') RETURNING * INTO f;
    refunds := jsonb_build_array(jsonb_build_object('refund_id',f.id,'amount_cents',f.amount_cents));
   END IF;
   UPDATE public.commerce_cases SET status='resolved', turn=NULL, version=version+1, updated_at=now(),
    resolution=jsonb_build_object('kind','refund_full','amount_cents',coalesce(f.amount_cents,0),'order_id',o.id,'how','auto',
     'by','platform','at',now()) WHERE id=c.id RETURNING * INTO c;
   INSERT INTO public.commerce_case_moves(case_id,by,action,remedy,version) VALUES(c.id,'platform','auto',c.resolution,c.version);
   PERFORM public.commerce_res_event('case.resolved','buyer',public.commerce_case_payload(c.id));
   PERFORM public.commerce_res_event('case.resolved','seller',public.commerce_case_payload(c.id));
   RETURN public.commerce_case_result(c.id, refunds);
  END IF;
 ELSIF p_type='changed_mind' THEN
  IF o.status='confirmed' THEN
   rem := public.commerce_norm_remedy(c.id, '{"kind":"cancel"}'); how := 'policy';
  ELSIF o.delivered_at IS NOT NULL AND now() > o.delivered_at + make_interval(days => pol.return_window_days) THEN
   UPDATE public.commerce_cases SET status='closed', turn=NULL, version=version+1, updated_at=now(),
    resolution=jsonb_build_object('kind','decline','reason','outside the return window','how','policy','by','platform','at',now())
   WHERE id=c.id RETURNING * INTO c;
   INSERT INTO public.commerce_case_moves(case_id,by,action,note,version) VALUES(c.id,'platform','decline','Outside the seller''s return window.',c.version);
   PERFORM public.commerce_res_event('case.resolved','buyer',public.commerce_case_payload(c.id));
   RETURN public.commerce_case_result(c.id,'[]');
  ELSE
   rem := public.commerce_norm_remedy(c.id, jsonb_build_object('kind','return_for_refund','items',items)); how := 'policy';
  END IF;
 ELSIF requested IS NOT NULL AND requested->>'kind' IN ('refund_partial','keep_with_discount')
   AND (requested->>'amount_cents')::integer * 100 <= o.total_cents * pol.max_auto_partial_refund_pct THEN
  rem := requested; how := 'policy';
 END IF;

 IF rem IS NOT NULL THEN
  refunds := public.commerce_apply_remedy(c.id, rem, how, 'platform');
 ELSE
  UPDATE public.commerce_cases SET remedy=requested, remedy_by=CASE WHEN requested IS NULL THEN NULL ELSE 'buyer' END
  WHERE id=c.id;
  PERFORM public.commerce_res_event('case.opened','seller',public.commerce_case_payload(c.id));
 END IF;
 RETURN public.commerce_case_result(c.id, refunds);
END $$;

-- ---------- either party: respond, evidence ----------

-- accept the remedy on the table, counter with another (round cap 6, then escalated), or decline (escalated).
CREATE FUNCTION public.commerce_respond_case(p_actor uuid, p_scope text, p_seller uuid, p_case uuid, p_expected_version integer,
 p_action text, p_remedy jsonb, p_note text, p_key text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.commerce_cases; role text; rem jsonb; refunds jsonb := '[]';
BEGIN
 role := public.commerce_case_role(p_case, p_actor, p_scope, p_seller);
 IF p_key IS NOT NULL AND EXISTS (SELECT 1 FROM public.commerce_case_moves WHERE case_id=p_case AND idempotency_key=p_key) THEN
  RETURN public.commerce_case_result(p_case,'[]'); END IF;
 IF p_action IS NULL OR p_action NOT IN ('accept','counter','decline') THEN RAISE EXCEPTION 'invalid_input'; END IF;
 IF p_note IS NOT NULL AND length(p_note) > 500 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO c FROM public.commerce_cases WHERE id=p_case FOR UPDATE;
 IF c.status <> 'open' THEN RAISE EXCEPTION 'case_closed'; END IF;
 IF c.turn IS DISTINCT FROM role THEN RAISE EXCEPTION 'not_your_turn'; END IF;
 IF p_expected_version IS DISTINCT FROM c.version THEN RAISE EXCEPTION 'stale_case'; END IF;
 IF p_action = 'accept' THEN
  IF c.remedy IS NULL OR c.remedy_by = role THEN RAISE EXCEPTION 'nothing_to_accept'; END IF;
  rem := public.commerce_norm_remedy(c.id, c.remedy);
  refunds := public.commerce_apply_remedy(c.id, rem, 'agreed', role);
  UPDATE public.commerce_case_moves SET idempotency_key=p_key, note=left(p_note,500)
  WHERE id=(SELECT id FROM public.commerce_case_moves WHERE case_id=c.id ORDER BY created_at DESC, version DESC LIMIT 1);
 ELSIF p_action = 'decline' THEN
  PERFORM public.commerce_escalate_case(c.id, role, coalesce(p_note,'Declined; needs a person.'));
  UPDATE public.commerce_case_moves SET idempotency_key=p_key
  WHERE id=(SELECT id FROM public.commerce_case_moves WHERE case_id=c.id ORDER BY created_at DESC, version DESC LIMIT 1);
 ELSE
  rem := public.commerce_norm_remedy(c.id, p_remedy);
  IF c.rounds >= 6 THEN
   PERFORM public.commerce_escalate_case(c.id, 'platform', 'Round limit reached; needs a person.');
  ELSE
   UPDATE public.commerce_cases SET remedy=rem, remedy_by=role, turn=CASE WHEN role='buyer' THEN 'seller' ELSE 'buyer' END,
    version=version+1, rounds=rounds+1, updated_at=now() WHERE id=c.id RETURNING * INTO c;
   INSERT INTO public.commerce_case_moves(case_id,by,action,remedy,note,version,idempotency_key)
   VALUES(c.id,role,'offer',rem,left(p_note,500),c.version,p_key);
   PERFORM public.commerce_res_event('case.offer',c.turn,public.commerce_case_payload(c.id));
  END IF;
 END IF;
 RETURN public.commerce_case_result(c.id, refunds);
END $$;

CREATE FUNCTION public.commerce_add_evidence(p_actor uuid, p_scope text, p_seller uuid, p_case uuid, p_evidence jsonb, p_key text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.commerce_cases; role text; ev jsonb;
BEGIN
 role := public.commerce_case_role(p_case, p_actor, p_scope, p_seller);
 IF p_key IS NOT NULL AND EXISTS (SELECT 1 FROM public.commerce_case_moves WHERE case_id=p_case AND idempotency_key=p_key) THEN
  RETURN public.commerce_case_json(p_case); END IF;
 SELECT * INTO c FROM public.commerce_cases WHERE id=p_case FOR UPDATE;
 IF c.status NOT IN ('open','escalated') THEN RAISE EXCEPTION 'case_closed'; END IF;
 ev := public.commerce_norm_evidence(p_evidence, role);
 IF jsonb_array_length(ev) = 0 OR jsonb_array_length(c.evidence) + jsonb_array_length(ev) > 20 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 UPDATE public.commerce_cases SET evidence=evidence || ev, updated_at=now() WHERE id=c.id RETURNING * INTO c;
 INSERT INTO public.commerce_case_moves(case_id,by,action,remedy,version,idempotency_key)
 VALUES(c.id,role,'evidence',jsonb_build_object('evidence',ev),c.version,p_key);
 RETURN public.commerce_case_json(c.id);
END $$;

-- ---------- fulfilment ----------

CREATE FUNCTION public.commerce_mark_shipped(p_seller uuid, p_order uuid, p_carrier text, p_tracking text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o public.commerce_orders;
BEGIN
 PERFORM public.commerce_order_role(p_order, NULL, 'seller', p_seller);
 IF p_carrier IS NULL OR length(trim(p_carrier)) NOT BETWEEN 1 AND 80 OR p_tracking IS NULL OR length(trim(p_tracking)) NOT BETWEEN 1 AND 120 THEN
  RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO o FROM public.commerce_orders WHERE id=p_order FOR UPDATE;
 IF o.status <> 'confirmed' THEN RAISE EXCEPTION 'order_not_shippable'; END IF;
 UPDATE public.commerce_orders SET status='shipped', carrier=trim(p_carrier), tracking=trim(p_tracking), shipped_at=now(),
  delivered_at=NULL, delivery_evidence=NULL, dispute_window_ends_at=NULL WHERE id=o.id;
 PERFORM public.commerce_res_event('order.shipped','buyer',public.commerce_order_payload(o.id));
 RETURN public.commerce_order_json(o.id);
END $$;

-- p_source: 'simulated' (test-mode carrier scan, seller), 'carrier' (future webhook) or 'buyer_confirmed'.
CREATE FUNCTION public.commerce_mark_delivered(p_actor uuid, p_scope text, p_seller uuid, p_order uuid, p_source text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o public.commerce_orders; role text; pol public.commerce_resolution_policies;
BEGIN
 role := public.commerce_order_role(p_order, p_actor, p_scope, p_seller);
 IF p_source NOT IN ('simulated','carrier','buyer_confirmed') OR (p_source='buyer_confirmed') <> (role='buyer') THEN RAISE EXCEPTION 'forbidden'; END IF;
 SELECT * INTO o FROM public.commerce_orders WHERE id=p_order FOR UPDATE;
 IF o.status = 'delivered' THEN RETURN public.commerce_order_json(o.id); END IF;
 IF NOT (o.status = 'shipped' OR (o.status = 'confirmed' AND p_source='buyer_confirmed')) THEN RAISE EXCEPTION 'order_not_shipped'; END IF;
 pol := public.commerce_policy_row(o.seller_id);
 UPDATE public.commerce_orders SET status='delivered', delivered_at=now(),
  delivery_evidence=jsonb_build_object('source',p_source,'at',now()),
  dispute_window_ends_at=now() + make_interval(days => pol.return_window_days) WHERE id=o.id;
 IF p_source <> 'buyer_confirmed' THEN
  PERFORM public.commerce_res_event('order.delivered','buyer',public.commerce_order_payload(o.id));
 END IF;
 RETURN public.commerce_order_json(o.id);
END $$;

-- The seller reports it cannot fulfil: out_of_stock (with an optional substitute) or an address problem.
-- substitute: {replaces: <order line inventory_id>, inventory_id, unit_cents?}. The substitute ships at the
-- quantity of the line it replaces and never costs more than the buyer paid (unit_cents <= paid, >= floor).
CREATE FUNCTION public.commerce_report_fulfilment_issue(p_seller uuid, p_order uuid, p_kind text, p_items jsonb, p_substitute jsonb,
 p_note text, p_key text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o public.commerce_orders; c public.commerce_cases; items jsonb; line record; s public.commerce_inventory; unit integer;
 req jsonb; ok boolean; chk jsonb; rem jsonb; req_id uuid; ctype text;
BEGIN
 PERFORM public.commerce_order_role(p_order, NULL, 'seller', p_seller);
 IF p_key IS NOT NULL THEN
  SELECT * INTO c FROM public.commerce_cases WHERE order_id=p_order AND opened_by='seller' AND idempotency_key=p_key;
  IF FOUND THEN RETURN public.commerce_case_result(c.id,'[]'); END IF;
 END IF;
 IF p_kind IS NULL OR p_kind NOT IN ('out_of_stock','address_problem') THEN RAISE EXCEPTION 'invalid_input'; END IF;
 IF p_note IS NOT NULL AND length(p_note) > 500 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO o FROM public.commerce_orders WHERE id=p_order FOR UPDATE;
 IF o.status NOT IN ('confirmed','shipped') OR (p_kind='out_of_stock' AND o.status <> 'confirmed') THEN RAISE EXCEPTION 'order_not_shippable'; END IF;
 IF EXISTS (SELECT 1 FROM public.commerce_cases WHERE order_id=o.id AND status='open') THEN RAISE EXCEPTION 'case_already_open'; END IF;
 SELECT r.request_id, q.structured_requirements INTO req_id, req FROM public.commerce_reservations r
 JOIN public.commerce_requests q ON q.id=r.request_id WHERE r.id=o.reservation_id;
 items := public.commerce_case_items(o.id, p_items);
 ctype := CASE WHEN p_kind='address_problem' THEN 'address_problem' WHEN p_substitute IS NOT NULL AND p_substitute <> 'null'::jsonb
  THEN 'substitution' ELSE 'missing_item' END;
 IF ctype = 'substitution' THEN
  IF jsonb_typeof(p_substitute) <> 'object' THEN RAISE EXCEPTION 'invalid_input'; END IF;
  -- One affected item and no explicit `replaces`: the substitute replaces that item.
  IF NOT (p_substitute ? 'replaces') AND jsonb_array_length(items) = 1 THEN
   p_substitute := p_substitute || jsonb_build_object('replaces', items->0->>'inventory_id');
  END IF;
  IF coalesce(jsonb_typeof(p_substitute->'replaces'),'') <> 'string'
    OR coalesce(jsonb_typeof(p_substitute->'inventory_id'),'') <> 'string' THEN RAISE EXCEPTION 'invalid_input'; END IF;
  SELECT ri.inventory_id, ri.title, ri.quantity, ri.unit_cents, i.category, i.attributes INTO line
  FROM public.commerce_reservation_items ri JOIN public.commerce_inventory i ON i.id=ri.inventory_id
  WHERE ri.reservation_id=o.reservation_id AND ri.inventory_id::text=lower(p_substitute->>'replaces');
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_in_order'; END IF;
  SELECT * INTO s FROM public.commerce_inventory WHERE id::text=lower(p_substitute->>'inventory_id') AND seller_id=p_seller;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_input'; END IF;
  IF EXISTS (SELECT 1 FROM public.commerce_reservation_items WHERE reservation_id=o.reservation_id AND inventory_id=s.id) THEN
   RAISE EXCEPTION 'invalid_input'; END IF;
  IF p_substitute ? 'unit_cents' AND p_substitute->'unit_cents' <> 'null'::jsonb THEN
   IF jsonb_typeof(p_substitute->'unit_cents') <> 'number' OR (p_substitute->>'unit_cents')::numeric <> trunc((p_substitute->>'unit_cents')::numeric)
     THEN RAISE EXCEPTION 'invalid_input'; END IF;
   unit := (p_substitute->>'unit_cents')::integer;
  ELSE unit := line.unit_cents; END IF;
  IF unit > line.unit_cents THEN RAISE EXCEPTION 'price_increase_not_allowed'; END IF;
  IF unit < s.floor_cents THEN RAISE EXCEPTION 'below_floor'; END IF;
  IF s.available < line.quantity THEN RAISE EXCEPTION 'out_of_stock'; END IF;
  -- Does the substitute still meet what the buyer asked for? Same category, and the request's
  -- requirement for that category (if any) matches the substitute's attributes.
  SELECT t.x INTO chk FROM jsonb_array_elements(coalesce(req->'items','[]'::jsonb)) AS t(x) WHERE t.x->>'category'=line.category LIMIT 1;
  ok := s.category IS NOT DISTINCT FROM line.category
   AND (chk IS NULL OR public.commerce_item_matches(s.attributes, s.category, chk));
  chk := jsonb_build_object('meets_requirements',ok,'unit_cents_delta',unit-line.unit_cents,'category',s.category,'in_stock',true,
   'requirement',chk,
   'original',jsonb_build_object('inventory_id',line.inventory_id,'title',line.title,'unit_cents',line.unit_cents,'attributes',line.attributes),
   'substitute',jsonb_build_object('inventory_id',s.id,'title',s.title,'unit_cents',unit,'attributes',s.attributes,'quantity',line.quantity));
  rem := jsonb_build_object('kind','replace','substitute',jsonb_build_object('replaces',line.inventory_id,'inventory_id',s.id,
   'quantity',line.quantity,'unit_cents',unit,'title',s.title),'amount_cents',(line.unit_cents-unit)*line.quantity);
 ELSIF ctype = 'missing_item' THEN
  IF jsonb_array_length(items) = 0 THEN items := public.commerce_order_items(o.id); END IF;
 END IF;
 INSERT INTO public.commerce_cases(order_id,request_id,buyer_id,seller_id,opened_by,type,turn,items,description,remedy,remedy_by,
  substitute_check,idempotency_key)
 VALUES(o.id,req_id,o.buyer_id,o.seller_id,'seller',ctype,'buyer',items,p_note,NULL,NULL,chk,p_key) RETURNING * INTO c;
 IF ctype = 'missing_item' THEN rem := public.commerce_norm_remedy(c.id, jsonb_build_object('kind','refund_items','items',items)); END IF;
 UPDATE public.commerce_cases SET remedy=rem, remedy_by=CASE WHEN rem IS NULL THEN NULL ELSE 'seller' END WHERE id=c.id;
 INSERT INTO public.commerce_case_moves(case_id,by,action,remedy,note,version) VALUES(c.id,'seller','open',rem,left(p_note,500),1);
 PERFORM public.commerce_res_event('case.opened','buyer',public.commerce_case_payload(c.id));
 RETURN public.commerce_case_result(c.id,'[]');
END $$;

-- A returned item arrived: restock it and refund (the remedy agreed earlier).
CREATE FUNCTION public.commerce_confirm_return(p_seller uuid, p_case uuid, p_key text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.commerce_cases; e jsonb; amount integer; f public.commerce_refunds; refunds jsonb := '[]';
BEGIN
 PERFORM public.commerce_case_role(p_case, NULL, 'seller', p_seller);
 SELECT * INTO c FROM public.commerce_cases WHERE id=p_case FOR UPDATE;
 IF c.status <> 'resolved' OR c.resolution->>'kind' <> 'return_for_refund' THEN RAISE EXCEPTION 'no_return_expected'; END IF;
 IF EXISTS (SELECT 1 FROM public.commerce_case_moves WHERE case_id=c.id AND action='return_received') THEN
  RETURN public.commerce_case_result(c.id,'[]'); END IF;
 FOR e IN SELECT * FROM jsonb_array_elements(coalesce(c.resolution->'items','[]'::jsonb)) LOOP
  UPDATE public.commerce_inventory SET available=available+(e->>'quantity')::integer,
   sold=greatest(sold-(e->>'quantity')::integer,0) WHERE id=(e->>'inventory_id')::uuid;
 END LOOP;
 amount := least((c.resolution->>'amount_cents')::integer, public.commerce_refundable(c.order_id));
 IF amount > 0 THEN
  INSERT INTO public.commerce_refunds(order_id,case_id,amount_cents,reason) VALUES(c.order_id,c.id,amount,'return_for_refund') RETURNING * INTO f;
  refunds := jsonb_build_array(jsonb_build_object('refund_id',f.id,'amount_cents',f.amount_cents));
 END IF;
 INSERT INTO public.commerce_case_moves(case_id,by,action,version,idempotency_key) VALUES(c.id,'seller','return_received',c.version,p_key);
 RETURN public.commerce_case_result(c.id, refunds);
END $$;

-- ---------- refunds ----------

CREATE FUNCTION public.commerce_refund_target(p_refund uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT jsonb_build_object('refund_id',f.id,'order_id',f.order_id,'amount_cents',f.amount_cents,'status',f.status,
  'stripe_refund_id',f.stripe_refund_id,'payment_intent',o.stripe_payment_intent,'stripe_session_id',o.stripe_session_id,
  'buyer_id',o.buyer_id,'seller_id',o.seller_id)
 FROM public.commerce_refunds f JOIN public.commerce_orders o ON o.id=f.order_id WHERE f.id=p_refund
$$;

CREATE FUNCTION public.commerce_set_payment_intent(p_order uuid, p_payment_intent text)
RETURNS void LANGUAGE sql SET search_path = pg_catalog, public, pg_temp AS $$
 UPDATE public.commerce_orders SET stripe_payment_intent=p_payment_intent WHERE id=p_order AND stripe_payment_intent IS NULL
$$;

-- Record what Stripe did. succeeded is applied once: refunded_cents grows and a fully refunded order
-- becomes 'refunded' (a cancelled order stays cancelled).
CREATE FUNCTION public.commerce_refund_result(p_refund uuid, p_status text, p_stripe_id text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE f public.commerce_refunds; o public.commerce_orders;
BEGIN
 IF p_status NOT IN ('pending','succeeded','failed') THEN RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO f FROM public.commerce_refunds WHERE id=p_refund FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'refund_not_found'; END IF;
 IF f.status <> 'succeeded' THEN
  IF p_status = 'succeeded' THEN
   UPDATE public.commerce_refunds SET status='succeeded', stripe_refund_id=coalesce(p_stripe_id,stripe_refund_id), updated_at=now()
   WHERE id=f.id RETURNING * INTO f;
   UPDATE public.commerce_orders SET refunded_cents=refunded_cents+f.amount_cents,
    status=CASE WHEN refunded_cents+f.amount_cents >= total_cents AND status <> 'cancelled' THEN 'refunded' ELSE status END
   WHERE id=f.order_id RETURNING * INTO o;
   PERFORM public.commerce_res_event('refund.succeeded','buyer',jsonb_strip_nulls(jsonb_build_object('refund_id',f.id,'order_id',f.order_id,
    'case_id',f.case_id,'amount_cents',f.amount_cents,'reason',f.reason,'seller_id',o.seller_id,
    'title',(SELECT q.title FROM public.commerce_reservations r JOIN public.commerce_requests q ON q.id=r.request_id WHERE r.id=o.reservation_id))));
  ELSE
   UPDATE public.commerce_refunds SET status=p_status, stripe_refund_id=coalesce(p_stripe_id,stripe_refund_id), updated_at=now()
   WHERE id=f.id RETURNING * INTO f;
  END IF;
 END IF;
 RETURN jsonb_build_object('refund_id',f.id,'order_id',f.order_id,'amount_cents',f.amount_cents,'status',f.status);
END $$;

-- charge.refunded: Stripe says amount_refunded in total for this payment. Pending refunds that Stripe
-- already accepted (they have an ID) are marked succeeded, oldest first, while they fit.
CREATE FUNCTION public.commerce_reconcile_refunds(p_payment_intent text, p_amount_refunded integer)
RETURNS integer LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o public.commerce_orders; f public.commerce_refunds; done integer := 0; total integer;
BEGIN
 SELECT * INTO o FROM public.commerce_orders WHERE stripe_payment_intent=p_payment_intent LIMIT 1;
 IF NOT FOUND THEN RETURN 0; END IF;
 total := o.refunded_cents;
 FOR f IN SELECT * FROM public.commerce_refunds WHERE order_id=o.id AND status='pending' AND stripe_refund_id IS NOT NULL ORDER BY created_at LOOP
  EXIT WHEN total + f.amount_cents > p_amount_refunded;
  PERFORM public.commerce_refund_result(f.id,'succeeded',NULL);
  total := total + f.amount_cents; done := done + 1;
 END LOOP;
 RETURN done;
END $$;

-- ---------- disputes (chargebacks) ----------

CREATE FUNCTION public.commerce_record_dispute(p_stripe_dispute text, p_payment_intent text, p_reason text, p_amount integer, p_status text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o public.commerce_orders; d public.commerce_disputes; created boolean := false;
BEGIN
 SELECT * INTO d FROM public.commerce_disputes WHERE stripe_dispute_id=p_stripe_dispute FOR UPDATE;
 IF NOT FOUND THEN
  SELECT * INTO o FROM public.commerce_orders WHERE stripe_payment_intent=p_payment_intent LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  INSERT INTO public.commerce_disputes(order_id,stripe_dispute_id,reason,amount_cents,status)
  VALUES(o.id,p_stripe_dispute,left(p_reason,100),coalesce(p_amount,0),coalesce(left(p_status,60),'needs_response')) RETURNING * INTO d;
  created := true;
  PERFORM public.commerce_res_event('dispute.created','seller',public.commerce_order_payload(o.id)
   || jsonb_strip_nulls(jsonb_build_object('dispute_id',d.id,'reason',d.reason,'amount_cents',d.amount_cents)));
 ELSE
  UPDATE public.commerce_disputes SET status=coalesce(left(p_status,60),status), updated_at=now() WHERE id=d.id RETURNING * INTO d;
 END IF;
 RETURN jsonb_build_object('dispute_id',d.id,'order_id',d.order_id,'stripe_dispute_id',d.stripe_dispute_id,'reason',d.reason,
  'amount_cents',d.amount_cents,'status',d.status,'decision',d.decision,'created',created);
END $$;

-- Facts for a dispute response: what was agreed (transcript and structured items), that a person approved
-- the payment, shipping and delivery, and any cases or refunds. No floors, budgets or emails.
CREATE FUNCTION public.commerce_dispute_evidence(p_order uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT jsonb_build_object('order',public.commerce_order_json(o.id) - 'disputes',
  'agreement',jsonb_build_object('offer_id',r.offer_id,'items',(SELECT coalesce(jsonb_agg(jsonb_build_object('title',i.title,
    'category',i.category,'attributes',i.attributes,'quantity',oi.quantity,'unit_cents',oi.unit_cents) ORDER BY i.title),'[]'::jsonb)
    FROM public.commerce_offer_items oi JOIN public.commerce_inventory i ON i.id=oi.inventory_id WHERE oi.offer_id=r.offer_id),
   'transcript',(SELECT public.commerce_session_messages(f.session_id) FROM public.commerce_offers f WHERE f.id=r.offer_id)),
  'approval',jsonb_build_object('reserved_at',r.created_at,'checkout_session',o.stripe_session_id,'paid_at',o.created_at,
   'statement','The buyer approved this purchase themselves: an agent negotiated it, but reserving and paying are human-only actions.'),
  'cases',(SELECT coalesce(jsonb_agg(jsonb_build_object('type',c.type,'status',c.status,'resolution',c.resolution) ORDER BY c.created_at),'[]'::jsonb)
   FROM public.commerce_cases c WHERE c.order_id=o.id),
  'policy',public.commerce_get_policy(o.seller_id) - 'seller_id')
 FROM public.commerce_orders o JOIN public.commerce_reservations r ON r.id=o.reservation_id WHERE o.id=p_order
$$;

CREATE FUNCTION public.commerce_dispute_decided(p_dispute uuid, p_decision text, p_evidence jsonb, p_submitted boolean, p_status text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.commerce_disputes; first boolean;
BEGIN
 IF p_decision NOT IN ('fight','accept') THEN RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO d FROM public.commerce_disputes WHERE id=p_dispute FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'dispute_not_found'; END IF;
 first := d.decision IS NULL;
 UPDATE public.commerce_disputes SET decision=p_decision, evidence=coalesce(p_evidence,evidence),
  submitted_at=CASE WHEN p_submitted THEN coalesce(submitted_at,now()) ELSE submitted_at END,
  status=coalesce(left(p_status,60),status), updated_at=now() WHERE id=d.id RETURNING * INTO d;
 IF first THEN
  PERFORM public.commerce_res_event('dispute.decided','seller',public.commerce_order_payload(d.order_id)
   || jsonb_build_object('dispute_id',d.id,'decision',d.decision,'amount_cents',d.amount_cents,'reason',d.reason));
 END IF;
 RETURN jsonb_build_object('dispute_id',d.id,'order_id',d.order_id,'decision',d.decision,'status',d.status,'submitted_at',d.submitted_at);
END $$;

CREATE FUNCTION public.commerce_dispute_status(p_stripe_dispute text, p_status text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.commerce_disputes;
BEGIN
 UPDATE public.commerce_disputes SET status=left(p_status,60), updated_at=now() WHERE stripe_dispute_id=p_stripe_dispute RETURNING * INTO d;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('dispute_id',d.id,'order_id',d.order_id,'status',d.status,'decision',d.decision);
END $$;

-- ---------- email your agent ----------

-- A buyer's delegated requests, found by the exact account email (the runner answers "how is my order?"
-- emails to that same address). Status summary only: no budgets, targets or other people's data.
CREATE FUNCTION public.commerce_buyer_requests_by_email(p_email text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE out jsonb;
BEGIN
 IF p_email IS NULL OR length(trim(p_email)) NOT BETWEEN 3 AND 320 OR position('@' IN p_email) = 0 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT coalesce(jsonb_agg(x.r ORDER BY x.created_at DESC, x.id),'[]'::jsonb) INTO out FROM (
  SELECT q.id, q.created_at, jsonb_build_object('request_id',q.id,'title',q.title,'status',q.status,'created_at',q.created_at,
   'sessions_open',(SELECT count(*) FROM public.commerce_sessions s WHERE s.request_id=q.id AND s.status='open'),
   'best_offer',(SELECT jsonb_build_object('seller_name',sl.name,'total_cents',
      (SELECT coalesce(sum(oi.quantity::bigint*oi.unit_cents),0) FROM public.commerce_offer_items oi WHERE oi.offer_id=f.id)
       +f.delivery_cents+f.tax_cents)
     FROM public.commerce_sessions s JOIN public.commerce_offers f ON f.id=s.latest_offer_id AND f.is_current
     JOIN public.commerce_sellers sl ON sl.id=s.seller_id WHERE s.request_id=q.id AND s.status='open'
     ORDER BY (SELECT coalesce(sum(oi.quantity::bigint*oi.unit_cents),0) FROM public.commerce_offer_items oi WHERE oi.offer_id=f.id)
      +f.delivery_cents+f.tax_cents, sl.name LIMIT 1),
   'order',(SELECT jsonb_build_object('order_id',o.id,'status',o.status,'seller_name',sl.name,'total_cents',o.total_cents)
     FROM public.commerce_reservations r JOIN public.commerce_orders o ON o.reservation_id=r.id
     JOIN public.commerce_sellers sl ON sl.id=o.seller_id WHERE r.request_id=q.id LIMIT 1),
   'watch_path','/watch/'||q.id) AS r
  FROM public.commerce_requests q JOIN public.commerce_actors a ON a.id=q.buyer_id JOIN auth.users u ON u.id=a.auth_user_id
  WHERE lower(trim(u.email))=lower(trim(p_email)) AND q.delegate_negotiation
   AND (q.status IN ('negotiating','awaiting_payment') OR (q.status='confirmed' AND q.created_at > now() - interval '14 days'))
  ORDER BY q.created_at DESC, q.id LIMIT 10) x;
 RETURN out;
END $$;

-- A business's name and owner email for the runner's owner notices (case and dispute emails), also for
-- owners who negotiate by hand (no seller-agent token). commerce_business_json reads auth.users as definer.
CREATE FUNCTION public.commerce_seller_owner(p_seller uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT jsonb_build_object('seller_id',b->>'seller_id','name',b->>'name','owner_email',b->'owner_email')
 FROM public.commerce_business_json(p_seller) b
$$;

-- ---------- worker feed for resolution events ----------

CREATE FUNCTION public.commerce_resolution_events(p_limit integer)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,'created_at',e.created_at,'payload',e.payload,
  'route',jsonb_strip_nulls(jsonb_build_object('to_role',e.to_role,'request_id',e.request_id,'seller_id',e.seller_id,
   'buyer_id',e.buyer_id,'agent_handle',e.agent_handle,'delegated',e.delegated,'seller_delegated',e.seller_delegated,
   'order_id',e.order_id,'case_id',e.case_id)))
  ORDER BY e.created_at, e.id),'[]'::jsonb)
 FROM (SELECT o.id, split_part(o.kind,':',2) AS kind, split_part(o.kind,':',3) AS to_role, o.created_at, o.payload,
   q.id AS request_id, sl.id AS seller_id, q.buyer_id, sl.agent_handle, q.delegate_negotiation AS delegated,
   sl.delegate_negotiation AS seller_delegated, ord.id AS order_id, o.payload->>'case_id' AS case_id
  FROM public.commerce_outbox o
  JOIN public.commerce_orders ord ON ord.id=(o.payload->>'order_id')::uuid
  JOIN public.commerce_reservations r ON r.id=ord.reservation_id
  JOIN public.commerce_requests q ON q.id=r.request_id JOIN public.commerce_sellers sl ON sl.id=ord.seller_id
  WHERE o.delivered_at IS NULL AND o.kind LIKE 'res:%'
  ORDER BY o.created_at, o.id LIMIT least(greatest(coalesce(p_limit,20),1),100)) e
$$;

CREATE FUNCTION public.commerce_ack_resolution_event(p_event uuid, p_delivery jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE e public.commerce_outbox; receipt jsonb; k text; v jsonb;
BEGIN
 IF p_delivery IS NOT NULL AND jsonb_typeof(p_delivery) <> 'null' THEN
  IF jsonb_typeof(p_delivery) <> 'object' THEN RAISE EXCEPTION 'invalid_input'; END IF;
  receipt := '{}'::jsonb;
  FOR k, v IN SELECT * FROM jsonb_each(p_delivery) LOOP
   CONTINUE WHEN k NOT IN ('transport','from_handle','to_handle','message_id','context_id','delivered_at');
   IF jsonb_typeof(v) <> 'string' OR length(v #>> '{}') > 200 THEN RAISE EXCEPTION 'invalid_input'; END IF;
   receipt := receipt || jsonb_build_object(k, v #>> '{}');
  END LOOP;
  IF receipt ? 'transport' AND receipt->>'transport' NOT IN ('inkbox','local') THEN RAISE EXCEPTION 'invalid_input'; END IF;
  IF receipt = '{}'::jsonb THEN receipt := NULL; END IF;
 END IF;
 UPDATE public.commerce_outbox SET delivered_at=coalesce(delivered_at,now()), delivery=coalesce(delivery,receipt)
 WHERE id=p_event AND kind LIKE 'res:%' RETURNING * INTO e;
 IF NOT FOUND THEN RAISE EXCEPTION 'event_not_found'; END IF;
 RETURN jsonb_build_object('id',e.id,'kind',split_part(e.kind,':',2),'delivered_at',e.delivered_at);
END $$;

-- Delivered orders past their dispute window with no open case are closed.
CREATE FUNCTION public.commerce_resolution_sweep()
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n integer;
BEGIN
 UPDATE public.commerce_orders o SET status='closed'
 WHERE o.status='delivered' AND o.dispute_window_ends_at IS NOT NULL AND o.dispute_window_ends_at < now()
  AND NOT EXISTS (SELECT 1 FROM public.commerce_cases c WHERE c.order_id=o.id AND c.status='open');
 GET DIAGNOSTICS n = ROW_COUNT;
 RETURN jsonb_build_object('orders_closed',n);
END $$;

DO $$ DECLARE t text; f record; BEGIN
 FOREACH t IN ARRAY ARRAY['commerce_resolution_policies','commerce_cases','commerce_case_moves','commerce_refunds','commerce_disputes'] LOOP
   EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated',t);
 END LOOP;
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname IN ('commerce_try_date','commerce_order_deadline','commerce_policy_row','commerce_get_policy',
   'commerce_set_policy','commerce_order_role','commerce_refundable','commerce_order_items','commerce_case_items','commerce_items_value',
   'commerce_norm_remedy','commerce_res_event','commerce_case_payload','commerce_order_payload','commerce_order_json','commerce_buyer_orders',
   'commerce_seller_orders','commerce_case_json','commerce_case_result','commerce_cases_for','commerce_case_role','commerce_swap_substitute',
   'commerce_apply_remedy','commerce_escalate_case','commerce_norm_evidence','commerce_open_case','commerce_respond_case',
   'commerce_add_evidence','commerce_mark_shipped','commerce_mark_delivered','commerce_report_fulfilment_issue','commerce_confirm_return',
   'commerce_refund_target','commerce_set_payment_intent','commerce_refund_result','commerce_reconcile_refunds','commerce_record_dispute',
   'commerce_dispute_evidence','commerce_dispute_decided','commerce_dispute_status','commerce_buyer_requests_by_email',
   'commerce_resolution_events','commerce_ack_resolution_event','commerce_resolution_sweep','commerce_seller_owner') LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.signature);
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO project_admin',f.signature);
 END LOOP;
END $$;
