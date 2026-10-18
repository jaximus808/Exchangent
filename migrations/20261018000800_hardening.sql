-- Hardening round 1 (doc/hardening-contract.md). Additive for every existing caller: function
-- signatures keep their arguments (new ones have defaults), the worker feed only shows the new event
-- kinds to a runner that asks for them (p_v => 2), and outbox payloads still never carry floors,
-- budgets, targets or buyer email.
--
-- Lock order everywhere below matches the existing offer/counter/decline functions: session(s) first,
-- then the request. commerce_reserve keeps request -> offer -> inventory.

-- 1. Schema.
ALTER TABLE public.commerce_orders ADD COLUMN stripe_payment_intent text CHECK(length(stripe_payment_intent) <= 255);
ALTER TABLE public.commerce_requests DROP CONSTRAINT IF EXISTS commerce_requests_status_check;
ALTER TABLE public.commerce_requests ADD CONSTRAINT commerce_requests_status_check
 CHECK(status IN ('negotiating','awaiting_payment','confirmed','expired'));
-- A request idempotency key replays only a live request (negotiating or awaiting payment). After the
-- request is confirmed or expired, the same key (identical wording) starts a new request.
ALTER TABLE public.commerce_requests DROP CONSTRAINT commerce_requests_buyer_key;
CREATE UNIQUE INDEX commerce_requests_live_key ON public.commerce_requests(buyer_id, idempotency_key)
 WHERE status IN ('negotiating','awaiting_payment');
CREATE INDEX commerce_requests_buyer_key ON public.commerce_requests(buyer_id, idempotency_key);
CREATE INDEX commerce_requests_open_deadline ON public.commerce_requests(deadline)
 WHERE status='negotiating' AND deadline IS NOT NULL;

-- 2. Region normalization: lowercase, runs of anything else become '_', and common San Francisco
-- spellings map to 'san_francisco'. NULL or empty means "no region".
CREATE FUNCTION public.commerce_norm_region(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT CASE WHEN r IN ('sf','sfo','sf_ca','sanfrancisco','san_fran','san_francisco_ca','san_francisco_california',
   'san_francisco_bay_area','city_of_san_francisco') THEN 'san_francisco' ELSE r END
 FROM (SELECT nullif(trim(both '_' from regexp_replace(lower(coalesce(p,'')),'[^a-z0-9]+','_','g')),'') AS r) x
$$;

-- 3. requirements.deliver_by -> a deadline. A date (YYYY-MM-DD) means "by the end of that day anywhere
-- on Earth" (the next day, 12:00 UTC), so a buyer in San Francisco asking in the evening for "tomorrow"
-- still matches next-day sellers. An ISO 8601 timestamp is used as given. Anything else (including words
-- Postgres would accept, like 'tomorrow' = midnight) is ignored: no deadline, as before this migration.
CREATE FUNCTION public.commerce_deliver_by_deadline(p_requirements jsonb)
RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE v text;
BEGIN
 IF jsonb_typeof(p_requirements->'deliver_by') IS DISTINCT FROM 'string' THEN RETURN NULL; END IF;
 v := trim(p_requirements->>'deliver_by');
 BEGIN
  IF v ~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN ((v::date + 1)::timestamp + interval '12 hours') AT TIME ZONE 'UTC'; END IF;
  IF v ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}' THEN RETURN v::timestamptz; END IF;
  RETURN NULL;
 EXCEPTION WHEN others THEN RETURN NULL;
 END;
END $$;

-- 4. Close one open session for a reason (round limit, another offer accepted, deadline passed). Its
-- offers can no longer be reserved. Callers hold the session lock (or take it here, in session order).
-- Writes one 'session.closed' outbox row for the seller agent.
CREATE FUNCTION public.commerce_close_session(p_session uuid, p_reason text)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.commerce_sessions;
BEGIN
 UPDATE public.commerce_sessions SET status='closed', decline_reason=left(p_reason,500), version=version+1, updated_at=now()
 WHERE id=p_session AND status='open' RETURNING * INTO s;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE public.commerce_offers SET is_current=false WHERE session_id=s.id AND is_current;
 INSERT INTO public.commerce_outbox(kind,aggregate_id,payload)
 VALUES('session.closed',s.id,jsonb_build_object('session_id',s.id,'request_id',s.request_id,'reason',left(p_reason,500)))
 ON CONFLICT(kind,aggregate_id) DO NOTHING;
 RETURN true;
END $$;

-- 5. Request creation: caps, no self-matching, normalized regions, delivery deadline, live-only key replay.
-- Unchanged otherwise (validation, session.opened rows, the summary it returns).
CREATE OR REPLACE FUNCTION public.commerce_create_request(p_buyer uuid, p_key text, p_title text, p_requirements jsonb,
 p_budget_cents integer, p_target_cents integer, p_deadline timestamptz, p_delegate boolean)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE q public.commerce_requests; a public.commerce_actors; v_deadline timestamptz; v_region text;
BEGIN
 IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'idempotency_key_required'; END IF;
 -- One buyer's creations serialize on the actor row, so the caps and the key replay hold under concurrency.
 SELECT * INTO a FROM public.commerce_actors WHERE id=p_buyer FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF NOT public.commerce_valid_requirements(p_requirements) OR p_budget_cents IS NULL OR p_budget_cents <= 0
   OR p_target_cents <= 0 OR p_target_cents > p_budget_cents OR length(p_title) > 200 THEN
   RAISE EXCEPTION 'invalid_input'; END IF;
 -- Retry of a live request: return it. A confirmed or expired request's key starts a new request.
 SELECT * INTO q FROM public.commerce_requests WHERE buyer_id=p_buyer AND idempotency_key=p_key
  AND status IN ('negotiating','awaiting_payment');
 IF FOUND THEN
   IF q.structured_requirements<>p_requirements OR q.budget_cents<>p_budget_cents OR q.target_cents IS DISTINCT FROM p_target_cents
     OR q.title IS DISTINCT FROM p_title THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
   RETURN public.commerce_request_summary(q.id);
 END IF;
 -- Caps for people (seeded demo actors are platform-run): 5 open requests, 20 per 24 hours.
 IF NOT a.is_demo AND (
   (SELECT count(*) FROM public.commerce_requests WHERE buyer_id=p_buyer AND status='negotiating') >= 5
   OR (SELECT count(*) FROM public.commerce_requests WHERE buyer_id=p_buyer AND created_at > now()-interval '24 hours') >= 20)
 THEN RAISE EXCEPTION 'too_many_requests'; END IF;
 v_deadline := coalesce(p_deadline, public.commerce_deliver_by_deadline(p_requirements));
 v_region := public.commerce_norm_region(p_requirements->>'region');
 INSERT INTO public.commerce_requests(buyer_id,budget_cents,title,structured_requirements,target_cents,deadline,delegate_negotiation,idempotency_key)
 VALUES(p_buyer,p_budget_cents,p_title,p_requirements,p_target_cents,v_deadline,coalesce(p_delegate,true),p_key)
 RETURNING * INTO q;
 -- Match enabled sellers in the region, other than the buyer's own businesses, that can deliver by the
 -- deadline and cover every required item from available stock.
 INSERT INTO public.commerce_sessions(request_id,seller_id)
 SELECT q.id, sl.id FROM public.commerce_sellers sl
 WHERE sl.enabled AND sl.owner_id <> p_buyer
  AND (v_region IS NULL OR public.commerce_norm_region(sl.service_area) = v_region)
  AND (v_deadline IS NULL OR now() + make_interval(days => sl.delivery_days) <= v_deadline)
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_requirements->'items') r
   WHERE NOT EXISTS (SELECT 1 FROM public.commerce_inventory i WHERE i.seller_id=sl.id
    AND i.available >= coalesce((r->>'quantity')::integer,1) AND public.commerce_item_matches(i.attributes,i.category,r)))
 ORDER BY sl.id;
 INSERT INTO public.commerce_outbox(kind,aggregate_id,payload)
 SELECT 'session.opened', s.id, jsonb_build_object('session_id',s.id,'request_id',s.request_id)
 FROM public.commerce_sessions s WHERE s.request_id=q.id ORDER BY s.id;
 RETURN public.commerce_request_summary(q.id);
END $$;

-- 6. Seller offers: notes up to 500 characters, offers valid for 24 hours, and at most 8 offers per
-- session. When the cap is reached the session closes (committed) and the result carries
-- round_limit=true; the backend answers 409 round_limit. Unchanged otherwise.
CREATE OR REPLACE FUNCTION public.commerce_seller_offer(p_seller uuid, p_session uuid, p_key text, p_expected_version integer,
 p_items jsonb, p_delivery_cents integer, p_note text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.commerce_sessions; q public.commerce_requests; o public.commerce_offers; sl public.commerce_sellers;
 inv public.commerce_inventory; item jsonb; lines jsonb; total bigint := 0; delivery integer; next_version integer;
BEGIN
 IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'idempotency_key_required'; END IF;
 IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR length(p_note) > 500 THEN RAISE EXCEPTION 'invalid_input'; END IF;
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
 IF s.rounds >= 8 THEN
   PERFORM public.commerce_close_session(s.id,'round limit');
   RETURN jsonb_build_object('round_limit',true,'session_id',s.id,'status','closed');
 END IF;
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
 VALUES(q.id,p_seller,next_version,delivery,0,now()+interval '24 hours',true,s.id,s.version+1,p_note,p_key) RETURNING * INTO o;
 INSERT INTO public.commerce_offer_items(offer_id,inventory_id,quantity,unit_cents)
 SELECT o.id,(e->>'inventory_id')::uuid,(e->>'quantity')::integer,(e->>'unit_cents')::integer FROM jsonb_array_elements(lines) e;
 UPDATE public.commerce_sessions SET version=version+1, rounds=rounds+1, turn='buyer', latest_offer_id=o.id, updated_at=now()
 WHERE id=s.id RETURNING * INTO s;
 INSERT INTO public.commerce_outbox(kind,aggregate_id,payload) VALUES('offer.created',o.id,
  jsonb_build_object('session_id',s.id,'request_id',q.id,'offer_id',o.id,'total_cents',total,'note',p_note));
 RETURN jsonb_build_object('offer_id',o.id,'version',o.version,'total_cents',total,'session_version',s.version);
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'idempotency_conflict';
END $$;

-- 7. Buyer counters: notes up to 500 characters; after the seller's 8th offer the buyer reserves or
-- declines, and a further counter closes the session (round_limit, as above). Unchanged otherwise.
CREATE OR REPLACE FUNCTION public.commerce_buyer_counter(p_buyer uuid, p_session uuid, p_key text, p_expected_version integer,
 p_total_cents integer, p_note text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.commerce_sessions; q public.commerce_requests; c public.commerce_counters;
BEGIN
 IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'idempotency_key_required'; END IF;
 IF p_total_cents IS NULL OR p_total_cents <= 0 OR length(p_note) > 500 THEN RAISE EXCEPTION 'invalid_input'; END IF;
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
 IF s.rounds >= 8 THEN
   PERFORM public.commerce_close_session(s.id,'round limit');
   RETURN jsonb_build_object('round_limit',true,'session_id',s.id,'status','closed');
 END IF;
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

-- 8. Reservations: a key whose hold expired or failed starts a new hold (the dead hold's key is retired
-- with its own id appended), and an expired request says so. Unchanged otherwise.
CREATE OR REPLACE FUNCTION public.commerce_reserve(p_buyer uuid, p_offer uuid, p_key text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o public.commerce_offers; q public.commerce_requests; r public.commerce_reservations;
 item record; total bigint; request_uuid uuid;
BEGIN
 SELECT request_id INTO request_uuid FROM public.commerce_offers WHERE id=p_offer;
 IF request_uuid IS NULL THEN RAISE EXCEPTION 'offer_not_found'; END IF;
 -- All reservations for the same request serialize, including retries.
 SELECT * INTO q FROM public.commerce_requests WHERE id=request_uuid FOR UPDATE;
 IF q.buyer_id <> p_buyer THEN RAISE EXCEPTION 'forbidden'; END IF;
 SELECT * INTO r FROM public.commerce_reservations WHERE buyer_id=p_buyer AND idempotency_key=p_key;
 IF FOUND THEN
   IF r.status IN ('expired','failed') THEN
     UPDATE public.commerce_reservations SET idempotency_key=left(p_key,160)||'#'||r.id::text WHERE id=r.id;
   ELSE
     IF r.offer_id<>p_offer THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
     RETURN to_jsonb(r);
   END IF;
 END IF;
 IF q.status = 'expired' THEN RAISE EXCEPTION 'request_expired'; END IF;
 IF q.status <> 'negotiating' THEN RAISE EXCEPTION 'request_already_reserved'; END IF;
 SELECT * INTO o FROM public.commerce_offers WHERE id=p_offer FOR UPDATE;
 IF NOT o.is_current THEN RAISE EXCEPTION 'stale_offer'; END IF;
 IF o.expires_at <= now() THEN RAISE EXCEPTION 'offer_expired'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.commerce_sellers WHERE id=o.seller_id AND enabled) THEN
   RAISE EXCEPTION 'seller_disabled'; END IF;
 SELECT sum(quantity::bigint * unit_cents) + o.delivery_cents + o.tax_cents INTO total
 FROM public.commerce_offer_items WHERE offer_id=p_offer;
 IF total IS NULL OR total<=0 OR total>q.budget_cents THEN RAISE EXCEPTION 'budget_exceeded'; END IF;
 INSERT INTO public.commerce_reservations(request_id,buyer_id,offer_id,seller_id,offer_version,idempotency_key,total_cents,currency,expires_at)
 VALUES(q.id,p_buyer,o.id,o.seller_id,o.version,p_key,total,q.currency,now()+interval '35 minutes') RETURNING * INTO r;
 -- Stable item lock order prevents deadlocks between buyers of shared inventory.
 FOR item IN SELECT i.*, oi.quantity, oi.unit_cents FROM public.commerce_offer_items oi
 JOIN public.commerce_inventory i ON i.id=oi.inventory_id WHERE oi.offer_id=o.id ORDER BY i.id FOR UPDATE OF i LOOP
   IF item.seller_id<>o.seller_id THEN RAISE EXCEPTION 'seller_mismatch'; END IF;
   IF item.unit_cents<item.floor_cents THEN RAISE EXCEPTION 'below_floor'; END IF;
   IF item.available<item.quantity THEN RAISE EXCEPTION 'out_of_stock'; END IF;
   UPDATE public.commerce_inventory SET available=available-item.quantity WHERE id=item.id;
   INSERT INTO public.commerce_reservation_items VALUES(r.id,item.id,item.title,item.quantity,item.unit_cents);
 END LOOP;
 UPDATE public.commerce_requests SET status='awaiting_payment' WHERE id=q.id;
 RETURN to_jsonb(r);
END $$;

-- 9. Payment: also stores the Stripe PaymentIntent on the order, closes the request's other open
-- sessions ('another offer was accepted') and writes the buyer's order notice. The new argument is
-- optional, so the current backend's call still resolves. Unchanged otherwise.
DROP FUNCTION public.commerce_apply_payment(text,text,uuid,text,integer,text,boolean,boolean,boolean);
CREATE FUNCTION public.commerce_apply_payment(p_event text,p_type text,p_reservation uuid,p_session text,
 p_total integer,p_currency text,p_paid boolean,p_release boolean,p_pending boolean,p_payment_intent text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.commerce_reservations; ord public.commerce_orders; sid uuid; q public.commerce_requests; seller_name text;
BEGIN
 SELECT * INTO r FROM public.commerce_reservations WHERE id=p_reservation FOR UPDATE;
 IF NOT FOUND OR r.stripe_session_id IS DISTINCT FROM p_session THEN RAISE EXCEPTION 'session_mismatch'; END IF;
 IF r.total_cents<>p_total OR r.currency<>p_currency THEN RAISE EXCEPTION 'payment_mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM public.commerce_payment_events WHERE event_id=p_event) THEN
   RETURN jsonb_build_object('duplicate',true); END IF;
 IF p_paid THEN
   IF r.status IN ('expired','failed') THEN RAISE EXCEPTION 'payment_requires_reconciliation'; END IF;
   IF r.status<>'consumed' THEN
     -- Sessions before the request, the same order as offers and counters.
     PERFORM 1 FROM public.commerce_sessions WHERE request_id=r.request_id AND status='open' ORDER BY id FOR UPDATE;
     INSERT INTO public.commerce_orders(reservation_id,buyer_id,seller_id,total_cents,currency,stripe_session_id,stripe_payment_intent)
     VALUES(r.id,r.buyer_id,r.seller_id,r.total_cents,r.currency,p_session,left(p_payment_intent,255)) RETURNING * INTO ord;
     UPDATE public.commerce_inventory i SET sold=i.sold+ri.quantity FROM public.commerce_reservation_items ri
       WHERE ri.reservation_id=r.id AND ri.inventory_id=i.id;
     UPDATE public.commerce_reservations SET status='consumed' WHERE id=r.id;
     UPDATE public.commerce_requests SET status='confirmed' WHERE id=r.request_id RETURNING * INTO q;
     INSERT INTO public.commerce_outbox(kind,aggregate_id,payload)
       VALUES('order.confirmed',ord.id,jsonb_build_object('order_id',ord.id,'reservation_id',r.id));
     FOR sid IN SELECT id FROM public.commerce_sessions WHERE request_id=r.request_id AND status='open'
       AND seller_id<>r.seller_id ORDER BY id LOOP
       PERFORM public.commerce_close_session(sid,'another offer was accepted');
     END LOOP;
     SELECT name INTO seller_name FROM public.commerce_sellers WHERE id=r.seller_id;
     INSERT INTO public.commerce_outbox(kind,aggregate_id,payload)
       VALUES('order.confirmed.buyer',ord.id,jsonb_build_object('order_id',ord.id,'reservation_id',r.id,'request_id',r.request_id,
        'seller_id',r.seller_id,'seller_name',seller_name,'total_cents',ord.total_cents,'currency',ord.currency,'title',q.title))
       ON CONFLICT(kind,aggregate_id) DO NOTHING;
   ELSIF p_payment_intent IS NOT NULL THEN
     UPDATE public.commerce_orders SET stripe_payment_intent=coalesce(stripe_payment_intent,left(p_payment_intent,255))
     WHERE reservation_id=r.id;
   END IF;
 ELSIF p_release AND r.status IN ('held','checkout_open','payment_pending') THEN
   UPDATE public.commerce_inventory i SET available=i.available+ri.quantity FROM public.commerce_reservation_items ri
     WHERE ri.reservation_id=r.id AND ri.inventory_id=i.id;
   UPDATE public.commerce_reservations SET status='expired' WHERE id=r.id;
   UPDATE public.commerce_requests SET status='negotiating' WHERE id=r.request_id;
 ELSIF p_pending AND r.status IN ('held','checkout_open') THEN
   UPDATE public.commerce_reservations SET status='payment_pending' WHERE id=r.id;
 END IF;
 INSERT INTO public.commerce_payment_events(event_id,session_id,event_type) VALUES(p_event,p_session,p_type);
 SELECT * INTO ord FROM public.commerce_orders WHERE reservation_id=r.id;
 RETURN jsonb_build_object('duplicate',false,'order_id',ord.id,'confirmed',ord.id IS NOT NULL);
END $$;

-- 10. Sweep (POST /worker/sweep, every minute from the runner): release stale holds, and expire
-- negotiating requests past their deadline, closing their open sessions ('deadline passed'). Busy rows
-- are skipped and picked up by the next sweep.
CREATE FUNCTION public.commerce_sweep()
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE released integer; rid uuid; sid uuid; expired integer := 0; closed integer := 0;
BEGIN
 released := public.commerce_release_stale_holds();
 FOR rid IN SELECT id FROM public.commerce_requests WHERE status='negotiating' AND deadline IS NOT NULL AND deadline < now()
   ORDER BY deadline, id LIMIT 200 LOOP
  BEGIN
   PERFORM 1 FROM public.commerce_sessions WHERE request_id=rid AND status='open' ORDER BY id FOR UPDATE NOWAIT;
   PERFORM 1 FROM public.commerce_requests WHERE id=rid AND status='negotiating' AND deadline < now() FOR UPDATE NOWAIT;
   IF FOUND THEN
     FOR sid IN SELECT id FROM public.commerce_sessions WHERE request_id=rid AND status='open' ORDER BY id LOOP
       IF public.commerce_close_session(sid,'deadline passed') THEN closed := closed+1; END IF;
     END LOOP;
     UPDATE public.commerce_requests SET status='expired' WHERE id=rid;
     expired := expired+1;
   END IF;
  EXCEPTION WHEN lock_not_available THEN NULL;
  END;
 END LOOP;
 RETURN jsonb_build_object('released_holds',released,'expired_requests',expired,'closed_sessions',closed);
END $$;

-- 11. Businesses store a normalized service area (validation unchanged). Bodies as in migration 0600.
CREATE OR REPLACE FUNCTION public.commerce_register_business(p_actor uuid, p_name text, p_service_area text,
 p_delivery_cents integer, p_delivery_days integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE sl public.commerce_sellers; nm text := trim(p_name); area text := public.commerce_norm_region(p_service_area);
BEGIN
 IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.commerce_actors WHERE id=p_actor) THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF p_service_area IS NOT NULL AND area IS NULL THEN RAISE EXCEPTION 'invalid_input'; END IF;
 IF nm IS NULL OR NOT public.commerce_valid_business(nm,area,p_delivery_cents,p_delivery_days) THEN
   RAISE EXCEPTION 'invalid_input'; END IF;
 -- Serialize one actor's registrations so the limit holds under concurrency.
 PERFORM 1 FROM public.commerce_actors WHERE id=p_actor FOR UPDATE;
 IF (SELECT count(*) FROM public.commerce_sellers WHERE owner_id=p_actor) >= 5 THEN RAISE EXCEPTION 'business_limit'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('commerce_business_name:'||lower(nm)));
 IF EXISTS (SELECT 1 FROM public.commerce_sellers WHERE lower(trim(name))=lower(nm)) THEN RAISE EXCEPTION 'business_name_taken'; END IF;
 INSERT INTO public.commerce_sellers(owner_id,name,service_area,delivery_cents,delivery_days)
 VALUES(p_actor,nm,coalesce(area,'san_francisco'),coalesce(p_delivery_cents,0),coalesce(p_delivery_days,2))
 RETURNING * INTO sl;
 RETURN public.commerce_business_json(sl.id);
END $$;

CREATE OR REPLACE FUNCTION public.commerce_update_business(p_seller uuid, p_patch jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE sl public.commerce_sellers; nm text; area text; fee integer; days integer; delegate boolean;
BEGIN
 IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_patch) k
   WHERE k NOT IN ('name','service_area','delivery_cents','delivery_days','delegate_negotiation')) THEN
   RAISE EXCEPTION 'invalid_input'; END IF;
 IF (p_patch ? 'name' AND jsonb_typeof(p_patch->'name') <> 'string')
   OR (p_patch ? 'service_area' AND jsonb_typeof(p_patch->'service_area') <> 'string')
   OR (p_patch ? 'delivery_cents' AND jsonb_typeof(p_patch->'delivery_cents') <> 'number')
   OR (p_patch ? 'delivery_days' AND jsonb_typeof(p_patch->'delivery_days') <> 'number')
   OR (p_patch ? 'delegate_negotiation' AND jsonb_typeof(p_patch->'delegate_negotiation') <> 'boolean') THEN
   RAISE EXCEPTION 'invalid_input'; END IF;
 BEGIN
  nm := trim(p_patch->>'name'); area := public.commerce_norm_region(p_patch->>'service_area');
  fee := (p_patch->>'delivery_cents')::integer; days := (p_patch->>'delivery_days')::integer;
  delegate := (p_patch->>'delegate_negotiation')::boolean;
 EXCEPTION WHEN others THEN RAISE EXCEPTION 'invalid_input';
 END;
 IF (p_patch ? 'service_area' AND area IS NULL)
   OR fee::numeric IS DISTINCT FROM (p_patch->>'delivery_cents')::numeric
   OR days::numeric IS DISTINCT FROM (p_patch->>'delivery_days')::numeric
   OR NOT public.commerce_valid_business(nm,area,fee,days) THEN RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO sl FROM public.commerce_sellers WHERE id=p_seller FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'seller_not_found'; END IF;
 IF nm IS NOT NULL AND lower(nm)<>lower(trim(sl.name)) THEN
   PERFORM pg_advisory_xact_lock(hashtext('commerce_business_name:'||lower(nm)));
   IF EXISTS (SELECT 1 FROM public.commerce_sellers WHERE lower(trim(name))=lower(nm) AND id<>p_seller) THEN
     RAISE EXCEPTION 'business_name_taken'; END IF;
 END IF;
 UPDATE public.commerce_sellers SET name=coalesce(nm,name), service_area=coalesce(area,service_area),
  delivery_cents=coalesce(fee,delivery_cents), delivery_days=coalesce(days,delivery_days),
  delegate_negotiation=coalesce(delegate,delegate_negotiation) WHERE id=p_seller;
 IF sl.delegate_negotiation AND delegate IS FALSE THEN
   UPDATE public.commerce_principals SET revoked_at=now()
   WHERE seller_id=p_seller AND label LIKE 'agents:seller-agent:%' AND revoked_at IS NULL;
 END IF;
 RETURN public.commerce_business_json(p_seller);
END $$;

-- 12. Worker feed. p_v 1 (the default, what the running runner asks for) is exactly the 0600/0700 feed.
-- p_v 2 adds 'session.closed' (to the seller) and the buyer's order notice, shown as kind
-- 'order.confirmed' with route.to_role 'buyer'. A runner that doesn't know the new kinds never sees them.
DROP FUNCTION public.commerce_worker_events(integer);
CREATE FUNCTION public.commerce_worker_events(p_limit integer, p_v integer DEFAULT 1)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,'created_at',e.created_at,'payload',e.payload,
  'route',jsonb_strip_nulls(jsonb_build_object('to_role',e.to_role,'request_id',e.request_id,'seller_id',e.seller_id,
   'buyer_id',e.buyer_id,'agent_handle',e.agent_handle,'delegated',e.delegated,'seller_delegated',e.seller_delegated)))
  ORDER BY e.created_at, e.id),'[]'::jsonb)
 FROM (SELECT * FROM (
   SELECT o.id, o.kind, o.created_at, o.payload, q.id AS request_id, sl.id AS seller_id, q.buyer_id, sl.agent_handle,
    q.delegate_negotiation AS delegated, sl.delegate_negotiation AS seller_delegated,
    CASE WHEN o.kind='offer.created' OR (o.kind='session.declined' AND s.declined_by='seller') THEN 'buyer' ELSE 'seller' END AS to_role
   FROM public.commerce_outbox o
   JOIN public.commerce_sessions s ON s.id=(o.payload->>'session_id')::uuid
   JOIN public.commerce_requests q ON q.id=s.request_id JOIN public.commerce_sellers sl ON sl.id=s.seller_id
   WHERE o.delivered_at IS NULL AND (o.kind IN ('session.opened','offer.created','counter.created','session.declined')
    OR (coalesce(p_v,1) >= 2 AND o.kind='session.closed'))
  UNION ALL
   SELECT o.id, 'order.confirmed', o.created_at, o.payload, q.id, sl.id, q.buyer_id, sl.agent_handle,
    q.delegate_negotiation, sl.delegate_negotiation, CASE WHEN o.kind='order.confirmed.buyer' THEN 'buyer' ELSE 'seller' END
   FROM public.commerce_outbox o
   JOIN public.commerce_orders ord ON ord.id=o.aggregate_id
   JOIN public.commerce_reservations r ON r.id=ord.reservation_id
   JOIN public.commerce_requests q ON q.id=r.request_id JOIN public.commerce_sellers sl ON sl.id=ord.seller_id
   WHERE o.delivered_at IS NULL AND (o.kind='order.confirmed.seller'
    OR (coalesce(p_v,1) >= 2 AND o.kind='order.confirmed.buyer'))
  ) u ORDER BY u.created_at, u.id LIMIT least(greatest(coalesce(p_limit,20),1),100)) e
$$;

-- 13. Ack accepts the new kinds (receipts as in 0700). Both order notices ack as 'order.confirmed';
-- the receipt email's own 'order.confirmed' row is still never acked by the worker.
CREATE OR REPLACE FUNCTION public.commerce_ack_event(p_event uuid, p_delivery jsonb DEFAULT NULL)
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
 WHERE id=p_event AND kind IN ('session.opened','offer.created','counter.created','session.declined','session.closed',
  'order.confirmed.seller','order.confirmed.buyer')
 RETURNING * INTO e;
 IF NOT FOUND THEN RAISE EXCEPTION 'event_not_found'; END IF;
 RETURN jsonb_build_object('id',e.id,'kind',CASE WHEN e.kind IN ('order.confirmed.seller','order.confirmed.buyer') THEN 'order.confirmed'
  ELSE e.kind END,'delivered_at',e.delivered_at);
END $$;

DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname IN ('commerce_norm_region','commerce_deliver_by_deadline','commerce_close_session',
   'commerce_create_request','commerce_seller_offer','commerce_buyer_counter','commerce_reserve','commerce_apply_payment',
   'commerce_sweep','commerce_register_business','commerce_update_business','commerce_worker_events','commerce_ack_event') LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.signature);
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO project_admin',f.signature);
 END LOOP;
END $$;
