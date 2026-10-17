-- Negotiation loop (doc/negotiation-contract.md). Additive only: existing tables gain
-- defaulted/nullable columns, existing functions are unchanged. Every mutation below
-- commits its outbox row in the same transaction. Outbox payloads never carry budgets,
-- targets or floors.
ALTER TABLE public.commerce_sellers
 ADD COLUMN service_area text NOT NULL DEFAULT 'san_francisco',
 ADD COLUMN delivery_cents integer NOT NULL DEFAULT 0 CHECK(delivery_cents >= 0),
 ADD COLUMN delivery_days integer NOT NULL DEFAULT 2 CHECK(delivery_days >= 0),
 ADD COLUMN agent_handle text CHECK(length(agent_handle) BETWEEN 1 AND 200);
ALTER TABLE public.commerce_inventory
 ADD COLUMN list_cents integer CHECK(list_cents > 0),
 ADD COLUMN category text,
 ADD COLUMN attributes jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(attributes) = 'object');
ALTER TABLE public.commerce_requests
 ADD COLUMN title text CHECK(length(title) <= 200),
 ADD COLUMN structured_requirements jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(structured_requirements) = 'object'),
 ADD COLUMN target_cents integer CHECK(target_cents > 0),
 ADD COLUMN deadline timestamptz,
 ADD COLUMN delegate_negotiation boolean NOT NULL DEFAULT true,
 ADD COLUMN idempotency_key text CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
 ADD CONSTRAINT commerce_requests_buyer_key UNIQUE(buyer_id, idempotency_key);

CREATE TABLE public.commerce_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL REFERENCES public.commerce_requests,
 seller_id uuid NOT NULL REFERENCES public.commerce_sellers,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','declined','closed')),
 turn text NOT NULL DEFAULT 'seller' CHECK(turn IN ('seller','buyer')),
 version integer NOT NULL DEFAULT 0 CHECK(version >= 0),
 rounds integer NOT NULL DEFAULT 0 CHECK(rounds >= 0),
 latest_offer_id uuid REFERENCES public.commerce_offers, latest_counter_id uuid,
 declined_by text CHECK(declined_by IN ('buyer','seller')), decline_reason text CHECK(length(decline_reason) <= 500),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(request_id, seller_id)
);
-- Offers stay seller-authored only, so commerce_reserve needs no change.
ALTER TABLE public.commerce_offers
 ADD COLUMN session_id uuid REFERENCES public.commerce_sessions,
 ADD COLUMN session_version integer,
 ADD COLUMN note text CHECK(length(note) <= 2000),
 ADD COLUMN idempotency_key text CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
 ADD CONSTRAINT commerce_offers_seller_key UNIQUE(seller_id, idempotency_key);
-- version is the session version this counter produced.
CREATE TABLE public.commerce_counters (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 session_id uuid NOT NULL REFERENCES public.commerce_sessions,
 buyer_id uuid NOT NULL REFERENCES public.commerce_actors,
 responding_to_offer_id uuid NOT NULL REFERENCES public.commerce_offers,
 total_cents integer NOT NULL CHECK(total_cents > 0), note text CHECK(length(note) <= 2000),
 version integer NOT NULL CHECK(version > 0),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(buyer_id, idempotency_key), UNIQUE(session_id, version)
);
ALTER TABLE public.commerce_sessions ADD CONSTRAINT commerce_sessions_latest_counter
 FOREIGN KEY(latest_counter_id) REFERENCES public.commerce_counters;
-- Bearer tokens are stored only as sha256 hex.
CREATE TABLE public.commerce_principals (
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 actor_id uuid NOT NULL REFERENCES public.commerce_actors,
 scope text NOT NULL CHECK(scope IN ('buyer','seller','worker')),
 seller_id uuid REFERENCES public.commerce_sellers,
 label text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours', revoked_at timestamptz,
 CHECK((scope = 'seller') = (seller_id IS NOT NULL))
);
CREATE INDEX commerce_sessions_seller ON public.commerce_sessions(seller_id);
CREATE INDEX commerce_offers_session ON public.commerce_offers(session_id);
CREATE INDEX commerce_counters_session ON public.commerce_counters(session_id);
CREATE INDEX commerce_outbox_pending ON public.commerce_outbox(created_at) WHERE delivered_at IS NULL;

-- Requirement item keys other than category/quantity/notes filter inventory attributes:
-- max_<attr>/min_<attr> compare numbers, true booleans are required, strings/numbers match exactly.
CREATE FUNCTION public.commerce_item_matches(p_attrs jsonb, p_category text, p_req jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE k text; v jsonb; a jsonb;
BEGIN
 IF p_category IS DISTINCT FROM p_req->>'category' THEN RETURN false; END IF;
 FOR k, v IN SELECT * FROM jsonb_each(p_req) LOOP
  CONTINUE WHEN k IN ('category','quantity','notes');
  IF left(k,4) IN ('max_','min_') THEN
   a := p_attrs->substr(k,5);
   IF a IS NULL OR jsonb_typeof(a) <> 'number' THEN RETURN false; END IF;
   IF left(k,4)='max_' AND a::numeric > v::numeric THEN RETURN false; END IF;
   IF left(k,4)='min_' AND a::numeric < v::numeric THEN RETURN false; END IF;
  ELSIF jsonb_typeof(v) = 'boolean' THEN
   IF v = 'true'::jsonb AND (p_attrs->k) IS DISTINCT FROM 'true'::jsonb THEN RETURN false; END IF;
  ELSIF jsonb_typeof(v) IN ('string','number') THEN
   IF (p_attrs->k) IS DISTINCT FROM v THEN RETURN false; END IF;
  END IF;
 END LOOP;
 RETURN true;
END $$;

CREATE FUNCTION public.commerce_valid_requirements(p jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE item jsonb; k text; v jsonb;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(p->'items') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(p->'items') NOT BETWEEN 1 AND 10 THEN RETURN false; END IF;
 IF p ? 'region' AND jsonb_typeof(p->'region') <> 'string' THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p->'items') LOOP
  IF jsonb_typeof(item) <> 'object' OR jsonb_typeof(item->'category') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  IF item ? 'quantity' THEN
   IF jsonb_typeof(item->'quantity') <> 'number' THEN RETURN false; END IF;
   IF (item->>'quantity')::numeric NOT IN (1,2,3,4,5,6,7,8,9,10) THEN RETURN false; END IF;
  END IF;
  FOR k, v IN SELECT * FROM jsonb_each(item) LOOP
   IF left(k,4) IN ('max_','min_') AND jsonb_typeof(v) <> 'number' THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END $$;

CREATE FUNCTION public.commerce_request_summary(p_request uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT jsonb_build_object('request_id',q.id,'status',q.status,'sessions',coalesce((
  SELECT jsonb_agg(jsonb_build_object('session_id',s.id,'seller_id',s.seller_id,'seller_name',sl.name) ORDER BY sl.name, s.id)
  FROM public.commerce_sessions s JOIN public.commerce_sellers sl ON sl.id=s.seller_id WHERE s.request_id=q.id),'[]'::jsonb))
 FROM public.commerce_requests q WHERE q.id=p_request
$$;

CREATE FUNCTION public.commerce_create_request(p_buyer uuid, p_key text, p_title text, p_requirements jsonb,
 p_budget_cents integer, p_target_cents integer, p_deadline timestamptz, p_delegate boolean)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE q public.commerce_requests;
BEGIN
 IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'idempotency_key_required'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.commerce_actors WHERE id=p_buyer) THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF NOT public.commerce_valid_requirements(p_requirements) OR p_budget_cents IS NULL OR p_budget_cents <= 0
   OR p_target_cents <= 0 OR p_target_cents > p_budget_cents OR length(p_title) > 200 THEN
   RAISE EXCEPTION 'invalid_input'; END IF;
 INSERT INTO public.commerce_requests(buyer_id,budget_cents,title,structured_requirements,target_cents,deadline,delegate_negotiation,idempotency_key)
 VALUES(p_buyer,p_budget_cents,p_title,p_requirements,p_target_cents,p_deadline,coalesce(p_delegate,true),p_key)
 ON CONFLICT ON CONSTRAINT commerce_requests_buyer_key DO NOTHING RETURNING * INTO q;
 IF q.id IS NULL THEN
   -- Retry (possibly concurrent): the winning transaction has committed by now.
   SELECT * INTO q FROM public.commerce_requests WHERE buyer_id=p_buyer AND idempotency_key=p_key;
   IF q.structured_requirements<>p_requirements OR q.budget_cents<>p_budget_cents OR q.target_cents IS DISTINCT FROM p_target_cents
     OR q.title IS DISTINCT FROM p_title THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
   RETURN public.commerce_request_summary(q.id);
 END IF;
 -- Match enabled sellers in the region that can cover every required item from available stock.
 INSERT INTO public.commerce_sessions(request_id,seller_id)
 SELECT q.id, sl.id FROM public.commerce_sellers sl
 WHERE sl.enabled AND (p_requirements->>'region' IS NULL OR sl.service_area = p_requirements->>'region')
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_requirements->'items') r
   WHERE NOT EXISTS (SELECT 1 FROM public.commerce_inventory i WHERE i.seller_id=sl.id
    AND i.available >= coalesce((r->>'quantity')::integer,1) AND public.commerce_item_matches(i.attributes,i.category,r)))
 ORDER BY sl.id;
 INSERT INTO public.commerce_outbox(kind,aggregate_id,payload)
 SELECT 'session.opened', s.id, jsonb_build_object('session_id',s.id,'request_id',s.request_id)
 FROM public.commerce_sessions s WHERE s.request_id=q.id ORDER BY s.id;
 RETURN public.commerce_request_summary(q.id);
END $$;

CREATE FUNCTION public.commerce_seller_offer(p_seller uuid, p_session uuid, p_key text, p_expected_version integer,
 p_items jsonb, p_delivery_cents integer, p_note text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.commerce_sessions; q public.commerce_requests; o public.commerce_offers; sl public.commerce_sellers;
 inv public.commerce_inventory; item jsonb; lines jsonb; total bigint := 0; delivery integer; next_version integer;
BEGIN
 IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'idempotency_key_required'; END IF;
 IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR length(p_note) > 2000 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  IF jsonb_typeof(item) <> 'object' OR jsonb_typeof(item->'quantity') IS DISTINCT FROM 'number'
    OR jsonb_typeof(item->'unit_cents') IS DISTINCT FROM 'number'
    OR coalesce(item->>'inventory_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid_input'; END IF;
  IF (item->>'quantity')::numeric NOT BETWEEN 1 AND 100 OR (item->>'quantity')::numeric <> trunc((item->>'quantity')::numeric)
    OR (item->>'unit_cents')::numeric NOT BETWEEN 1 AND 100000000 OR (item->>'unit_cents')::numeric <> trunc((item->>'unit_cents')::numeric) THEN
    RAISE EXCEPTION 'invalid_input'; END IF;
 END LOOP;
 SELECT jsonb_agg(jsonb_build_object('inventory_id',(e->>'inventory_id')::uuid,'quantity',(e->>'quantity')::integer,
  'unit_cents',(e->>'unit_cents')::integer) ORDER BY (e->>'inventory_id')::uuid) INTO lines FROM jsonb_array_elements(p_items) e;
 IF (SELECT count(DISTINCT (e->>'inventory_id')::uuid) FROM jsonb_array_elements(p_items) e) <> jsonb_array_length(p_items) THEN
   RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO s FROM public.commerce_sessions WHERE id=p_session FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found'; END IF;
 IF s.seller_id <> p_seller THEN RAISE EXCEPTION 'forbidden'; END IF;
 SELECT * INTO sl FROM public.commerce_sellers WHERE id=p_seller;
 delivery := coalesce(p_delivery_cents, sl.delivery_cents);
 IF delivery NOT BETWEEN 0 AND 10000000 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 -- Same key: return the saved result; a different body is a conflict, never a second offer.
 SELECT * INTO o FROM public.commerce_offers WHERE seller_id=p_seller AND idempotency_key=p_key;
 IF FOUND THEN
   IF o.session_id IS DISTINCT FROM p_session OR o.delivery_cents<>delivery OR (SELECT jsonb_agg(jsonb_build_object(
     'inventory_id',inventory_id,'quantity',quantity,'unit_cents',unit_cents) ORDER BY inventory_id)
     FROM public.commerce_offer_items WHERE offer_id=o.id) IS DISTINCT FROM lines THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
   SELECT sum(quantity::bigint*unit_cents)+o.delivery_cents+o.tax_cents INTO total FROM public.commerce_offer_items WHERE offer_id=o.id;
   RETURN jsonb_build_object('offer_id',o.id,'version',o.version,'total_cents',total,'session_version',o.session_version);
 END IF;
 -- Lock order session -> request -> offers; commerce_reserve locks request -> offer, so no cycle.
 SELECT * INTO q FROM public.commerce_requests WHERE id=s.request_id FOR UPDATE;
 IF s.status <> 'open' OR q.status <> 'negotiating' OR NOT sl.enabled THEN RAISE EXCEPTION 'session_closed'; END IF;
 IF p_expected_version IS DISTINCT FROM s.version THEN RAISE EXCEPTION 'stale_offer'; END IF;
 IF s.turn <> 'seller' THEN RAISE EXCEPTION 'not_your_turn'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(lines) LOOP
  SELECT * INTO inv FROM public.commerce_inventory WHERE id=(item->>'inventory_id')::uuid;
  IF NOT FOUND OR inv.seller_id <> p_seller THEN RAISE EXCEPTION 'invalid_input'; END IF;
  IF (item->>'unit_cents')::integer < inv.floor_cents THEN RAISE EXCEPTION 'below_floor'; END IF;
  IF inv.available < (item->>'quantity')::integer THEN RAISE EXCEPTION 'out_of_stock'; END IF;
  total := total + (item->>'quantity')::bigint * (item->>'unit_cents')::integer;
 END LOOP;
 total := total + delivery;
 IF total > 2147483647 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 -- Every line must fit a requested item and every requested item must be covered.
 IF jsonb_typeof(q.structured_requirements->'items') = 'array' AND (
   EXISTS (SELECT 1 FROM jsonb_array_elements(lines) e JOIN public.commerce_inventory i ON i.id=(e->>'inventory_id')::uuid
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(q.structured_requirements->'items') r WHERE public.commerce_item_matches(i.attributes,i.category,r)))
   OR EXISTS (SELECT 1 FROM jsonb_array_elements(q.structured_requirements->'items') r WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(lines) e JOIN public.commerce_inventory i ON i.id=(e->>'inventory_id')::uuid
    WHERE public.commerce_item_matches(i.attributes,i.category,r) AND (e->>'quantity')::integer >= coalesce((r->>'quantity')::integer,1)))
 ) THEN RAISE EXCEPTION 'requirements_mismatch'; END IF;
 SELECT coalesce(max(version),0)+1 INTO next_version FROM public.commerce_offers WHERE request_id=q.id AND seller_id=p_seller;
 UPDATE public.commerce_offers SET is_current=false WHERE request_id=q.id AND seller_id=p_seller AND is_current;
 INSERT INTO public.commerce_offers(request_id,seller_id,version,delivery_cents,tax_cents,expires_at,is_current,
  session_id,session_version,note,idempotency_key)
 VALUES(q.id,p_seller,next_version,delivery,0,now()+interval '2 hours',true,s.id,s.version+1,p_note,p_key) RETURNING * INTO o;
 INSERT INTO public.commerce_offer_items(offer_id,inventory_id,quantity,unit_cents)
 SELECT o.id,(e->>'inventory_id')::uuid,(e->>'quantity')::integer,(e->>'unit_cents')::integer FROM jsonb_array_elements(lines) e;
 UPDATE public.commerce_sessions SET version=version+1, rounds=rounds+1, turn='buyer', latest_offer_id=o.id, updated_at=now()
 WHERE id=s.id RETURNING * INTO s;
 INSERT INTO public.commerce_outbox(kind,aggregate_id,payload) VALUES('offer.created',o.id,
  jsonb_build_object('session_id',s.id,'request_id',q.id,'offer_id',o.id,'total_cents',total,'note',p_note));
 RETURN jsonb_build_object('offer_id',o.id,'version',o.version,'total_cents',total,'session_version',s.version);
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'idempotency_conflict';
END $$;

CREATE FUNCTION public.commerce_buyer_counter(p_buyer uuid, p_session uuid, p_key text, p_expected_version integer,
 p_total_cents integer, p_note text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.commerce_sessions; q public.commerce_requests; c public.commerce_counters;
BEGIN
 IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'idempotency_key_required'; END IF;
 IF p_total_cents IS NULL OR p_total_cents <= 0 OR length(p_note) > 2000 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO s FROM public.commerce_sessions WHERE id=p_session FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found'; END IF;
 SELECT * INTO q FROM public.commerce_requests WHERE id=s.request_id FOR UPDATE;
 IF q.buyer_id <> p_buyer THEN RAISE EXCEPTION 'forbidden'; END IF;
 SELECT * INTO c FROM public.commerce_counters WHERE buyer_id=p_buyer AND idempotency_key=p_key;
 IF FOUND THEN
   IF c.session_id<>p_session OR c.total_cents<>p_total_cents THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
   RETURN jsonb_build_object('counter_id',c.id,'session_version',c.version);
 END IF;
 IF s.status <> 'open' OR q.status <> 'negotiating' THEN RAISE EXCEPTION 'session_closed'; END IF;
 IF p_expected_version IS DISTINCT FROM s.version THEN RAISE EXCEPTION 'stale_offer'; END IF;
 IF s.turn <> 'buyer' OR s.latest_offer_id IS NULL THEN RAISE EXCEPTION 'not_your_turn'; END IF;
 IF p_total_cents > q.budget_cents THEN RAISE EXCEPTION 'budget_exceeded'; END IF;
 INSERT INTO public.commerce_counters(session_id,buyer_id,responding_to_offer_id,total_cents,note,version,idempotency_key)
 VALUES(s.id,p_buyer,s.latest_offer_id,p_total_cents,p_note,s.version+1,p_key) RETURNING * INTO c;
 UPDATE public.commerce_sessions SET version=version+1, turn='seller', latest_counter_id=c.id, updated_at=now()
 WHERE id=s.id RETURNING * INTO s;
 INSERT INTO public.commerce_outbox(kind,aggregate_id,payload) VALUES('counter.created',c.id,
  jsonb_build_object('session_id',s.id,'counter_id',c.id,'total_cents',c.total_cents,'note',c.note));
 RETURN jsonb_build_object('counter_id',c.id,'session_version',s.version);
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'idempotency_conflict';
END $$;

-- Either participant may decline; repeating a decline is a no-op.
CREATE FUNCTION public.commerce_decline_session(p_actor uuid, p_scope text, p_seller uuid, p_session uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.commerce_sessions; q public.commerce_requests; role text;
BEGIN
 SELECT * INTO s FROM public.commerce_sessions WHERE id=p_session FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found'; END IF;
 SELECT * INTO q FROM public.commerce_requests WHERE id=s.request_id FOR UPDATE;
 IF p_scope='buyer' AND q.buyer_id=p_actor THEN role := 'buyer';
 ELSIF p_scope='seller' AND s.seller_id=p_seller THEN role := 'seller';
 ELSE RAISE EXCEPTION 'forbidden'; END IF;
 IF s.status='declined' THEN
   RETURN jsonb_build_object('session_id',s.id,'status',s.status,'session_version',s.version); END IF;
 IF s.status <> 'open' THEN RAISE EXCEPTION 'session_closed'; END IF;
 -- A declined seller's offer can no longer be reserved.
 UPDATE public.commerce_offers SET is_current=false WHERE id=s.latest_offer_id AND is_current;
 UPDATE public.commerce_sessions SET status='declined', declined_by=role, decline_reason=left(p_reason,500),
  version=version+1, updated_at=now() WHERE id=s.id RETURNING * INTO s;
 INSERT INTO public.commerce_outbox(kind,aggregate_id,payload)
 VALUES('session.declined',s.id,jsonb_build_object('session_id',s.id)) ON CONFLICT DO NOTHING;
 RETURN jsonb_build_object('session_id',s.id,'status',s.status,'session_version',s.version);
END $$;

-- Read helpers return unredacted state for the trusted server, which projects per role.
CREATE FUNCTION public.commerce_offer_json(p_offer uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT jsonb_build_object('offer_id',o.id,'session_id',o.session_id,'seller_id',o.seller_id,'version',o.version,
  'session_version',o.session_version,'is_current',o.is_current,'subtotal_cents',x.subtotal,
  'delivery_cents',o.delivery_cents,'tax_cents',o.tax_cents,'total_cents',x.subtotal+o.delivery_cents+o.tax_cents,
  'currency','usd','note',o.note,'expires_at',o.expires_at,'created_at',o.created_at,'items',x.items)
 FROM public.commerce_offers o CROSS JOIN LATERAL (
  SELECT coalesce(sum(oi.quantity::bigint*oi.unit_cents),0) AS subtotal, coalesce(jsonb_agg(jsonb_build_object(
   'inventory_id',i.id,'sku',i.sku,'title',i.title,'category',i.category,'attributes',i.attributes,'quantity',oi.quantity,
   'unit_cents',oi.unit_cents,'list_cents',i.list_cents,'floor_cents',i.floor_cents) ORDER BY i.category, i.title),'[]'::jsonb) AS items
  FROM public.commerce_offer_items oi JOIN public.commerce_inventory i ON i.id=oi.inventory_id WHERE oi.offer_id=o.id) x
 WHERE o.id=p_offer
$$;

CREATE FUNCTION public.commerce_counter_json(p_counter uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT jsonb_build_object('counter_id',c.id,'session_id',c.session_id,'responding_to_offer_id',c.responding_to_offer_id,
  'total_cents',c.total_cents,'note',c.note,'version',c.version,'created_at',c.created_at)
 FROM public.commerce_counters c WHERE c.id=p_counter
$$;

CREATE FUNCTION public.commerce_session_json(p_session uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT jsonb_build_object('session_id',s.id,'request_id',s.request_id,'seller_id',s.seller_id,'seller_name',sl.name,
  'seller',jsonb_build_object('service_area',sl.service_area,'delivery_cents',sl.delivery_cents,'delivery_days',sl.delivery_days,
   'agent_handle',sl.agent_handle),
  'status',s.status,'turn',s.turn,'version',s.version,'rounds',s.rounds,'declined_by',s.declined_by,
  'decline_reason',s.decline_reason,'created_at',s.created_at,'updated_at',s.updated_at,
  'current_offer',public.commerce_offer_json(s.latest_offer_id),'latest_counter',public.commerce_counter_json(s.latest_counter_id))
 FROM public.commerce_sessions s JOIN public.commerce_sellers sl ON sl.id=s.seller_id WHERE s.id=p_session
$$;

CREATE FUNCTION public.commerce_request_json(p_request uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT jsonb_build_object('request_id',q.id,'buyer_id',q.buyer_id,'title',q.title,'status',q.status,'requirements',q.structured_requirements,
  'budget_cents',q.budget_cents,'target_cents',q.target_cents,'currency',q.currency,'deadline',q.deadline,
  'delegate_negotiation',q.delegate_negotiation,'created_at',q.created_at)
 FROM public.commerce_requests q WHERE q.id=p_request
$$;

CREATE FUNCTION public.commerce_request_state(p_request uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT public.commerce_request_json(q.id) || jsonb_build_object(
  'sessions',coalesce((SELECT jsonb_agg(public.commerce_session_json(s.id) ORDER BY s.created_at, s.id)
   FROM public.commerce_sessions s WHERE s.request_id=q.id),'[]'::jsonb),
  'reservation',(SELECT jsonb_build_object('reservation_id',r.id,'offer_id',r.offer_id,'seller_id',r.seller_id,
   'status',r.status,'total_cents',r.total_cents,'expires_at',r.expires_at,'checkout_url',r.checkout_url)
   FROM public.commerce_reservations r WHERE r.request_id=q.id AND r.status IN ('held','checkout_open','payment_pending','consumed')))
 FROM public.commerce_requests q WHERE q.id=p_request
$$;

CREATE FUNCTION public.commerce_session_state(p_session uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT public.commerce_session_json(s.id) || jsonb_build_object(
  'request',public.commerce_request_json(s.request_id),
  'history',coalesce((SELECT jsonb_agg(h.entry ORDER BY h.v, h.t) FROM (
    SELECT o.session_version AS v, o.created_at AS t, jsonb_build_object('type','offer') || public.commerce_offer_json(o.id) AS entry
    FROM public.commerce_offers o WHERE o.session_id=s.id
    UNION ALL
    SELECT c.version, c.created_at, jsonb_build_object('type','counter') || public.commerce_counter_json(c.id)
    FROM public.commerce_counters c WHERE c.session_id=s.id) h),'[]'::jsonb))
 FROM public.commerce_sessions s WHERE s.id=p_session
$$;

CREATE FUNCTION public.commerce_seller_sessions(p_seller uuid, p_status text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT coalesce(jsonb_agg(public.commerce_session_json(s.id) || jsonb_build_object('request',jsonb_build_object(
   'request_id',q.id,'title',q.title,'status',q.status,'requirements',q.structured_requirements,'deadline',q.deadline,'created_at',q.created_at))
  ORDER BY s.created_at, s.id),'[]'::jsonb)
 FROM public.commerce_sessions s JOIN public.commerce_requests q ON q.id=s.request_id
 WHERE s.seller_id=p_seller AND (p_status IS NULL OR s.status=p_status)
$$;

CREATE FUNCTION public.commerce_seller_inventory(p_seller uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('inventory_id',i.id,'sku',i.sku,'title',i.title,'category',i.category,
  'attributes',i.attributes,'list_cents',i.list_cents,'floor_cents',i.floor_cents,'available',i.available,'sold',i.sold)
  ORDER BY i.category, i.title),'[]'::jsonb)
 FROM public.commerce_inventory i WHERE i.seller_id=p_seller
$$;

CREATE FUNCTION public.commerce_resolve_principal(p_token_hash text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT jsonb_build_object('actor_id',p.actor_id,'scope',p.scope,'seller_id',p.seller_id,'label',p.label)
 FROM public.commerce_principals p WHERE p.token_hash=p_token_hash AND p.revoked_at IS NULL AND p.expires_at>now()
$$;

-- Worker feed: negotiation events only (order.confirmed belongs to the email sender).
-- agent_handle is always the seller's Inkbox handle, whichever way the event travels.
CREATE FUNCTION public.commerce_worker_events(p_limit integer)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,'created_at',e.created_at,'payload',e.payload,
  'route',jsonb_strip_nulls(jsonb_build_object('to_role',e.to_role,'request_id',e.request_id,'seller_id',e.seller_id,
   'buyer_id',e.buyer_id,'agent_handle',e.agent_handle))) ORDER BY e.created_at, e.id),'[]'::jsonb)
 FROM (SELECT o.id, o.kind, o.created_at, o.payload, q.id AS request_id, sl.id AS seller_id, q.buyer_id, sl.agent_handle,
   CASE WHEN o.kind='offer.created' OR (o.kind='session.declined' AND s.declined_by='seller') THEN 'buyer' ELSE 'seller' END AS to_role
  FROM public.commerce_outbox o
  JOIN public.commerce_sessions s ON s.id=(o.payload->>'session_id')::uuid
  JOIN public.commerce_requests q ON q.id=s.request_id JOIN public.commerce_sellers sl ON sl.id=s.seller_id
  WHERE o.delivered_at IS NULL AND o.kind IN ('session.opened','offer.created','counter.created','session.declined')
  ORDER BY o.created_at, o.id LIMIT least(greatest(coalesce(p_limit,20),1),100)) e
$$;

CREATE FUNCTION public.commerce_ack_event(p_event uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE e public.commerce_outbox;
BEGIN
 UPDATE public.commerce_outbox SET delivered_at=coalesce(delivered_at,now())
 WHERE id=p_event AND kind IN ('session.opened','offer.created','counter.created','session.declined') RETURNING * INTO e;
 IF NOT FOUND THEN RAISE EXCEPTION 'event_not_found'; END IF;
 RETURN jsonb_build_object('id',e.id,'kind',e.kind,'delivered_at',e.delivered_at);
END $$;

CREATE FUNCTION public.commerce_set_agent_handle(p_seller uuid, p_handle text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE sl public.commerce_sellers;
BEGIN
 IF p_handle IS NULL OR length(p_handle) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 UPDATE public.commerce_sellers SET agent_handle=p_handle WHERE id=p_seller RETURNING * INTO sl;
 IF NOT FOUND THEN RAISE EXCEPTION 'seller_not_found'; END IF;
 RETURN jsonb_build_object('seller_id',sl.id,'agent_handle',sl.agent_handle);
END $$;

DO $$ DECLARE t text; f record; BEGIN
 FOREACH t IN ARRAY ARRAY['commerce_sessions','commerce_counters','commerce_principals'] LOOP
   EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated',t);
 END LOOP;
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname IN ('commerce_item_matches','commerce_valid_requirements','commerce_request_summary',
   'commerce_create_request','commerce_seller_offer','commerce_buyer_counter','commerce_decline_session','commerce_offer_json',
   'commerce_counter_json','commerce_session_json','commerce_request_json','commerce_request_state','commerce_session_state',
   'commerce_seller_sessions','commerce_seller_inventory','commerce_resolve_principal','commerce_worker_events',
   'commerce_ack_event','commerce_set_agent_handle') LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.signature);
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO project_admin',f.signature);
 END LOOP;
END $$;
