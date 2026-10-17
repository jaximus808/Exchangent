-- Server-only transaction foundation. No client role can read private base tables.
CREATE TABLE public.commerce_actors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 auth_user_id uuid UNIQUE REFERENCES auth.users(id),
 label text NOT NULL, is_demo boolean NOT NULL DEFAULT false
);
CREATE TABLE public.commerce_sellers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES public.commerce_actors,
 name text NOT NULL, enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE public.commerce_inventory (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_id uuid NOT NULL REFERENCES public.commerce_sellers,
 sku text NOT NULL, title text NOT NULL, floor_cents integer NOT NULL CHECK (floor_cents > 0),
 available integer NOT NULL CHECK (available >= 0), sold integer NOT NULL DEFAULT 0 CHECK (sold >= 0),
 UNIQUE(seller_id, sku)
);
CREATE TABLE public.commerce_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), buyer_id uuid NOT NULL REFERENCES public.commerce_actors,
 budget_cents integer NOT NULL CHECK (budget_cents > 0), currency text NOT NULL DEFAULT 'usd' CHECK(currency = 'usd'),
 status text NOT NULL DEFAULT 'negotiating' CHECK(status IN ('negotiating','awaiting_payment','confirmed'))
);
CREATE TABLE public.commerce_offers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL REFERENCES public.commerce_requests,
 seller_id uuid NOT NULL REFERENCES public.commerce_sellers, version integer NOT NULL CHECK(version > 0),
 delivery_cents integer NOT NULL DEFAULT 0 CHECK(delivery_cents >= 0),
 tax_cents integer NOT NULL DEFAULT 0 CHECK(tax_cents >= 0),
 expires_at timestamptz NOT NULL, is_current boolean NOT NULL DEFAULT true,
 UNIQUE(request_id, seller_id, version)
);
CREATE UNIQUE INDEX commerce_current_offer ON public.commerce_offers(request_id,seller_id) WHERE is_current;
CREATE TABLE public.commerce_offer_items (
 offer_id uuid NOT NULL REFERENCES public.commerce_offers, inventory_id uuid NOT NULL REFERENCES public.commerce_inventory,
 quantity integer NOT NULL CHECK(quantity > 0), unit_cents integer NOT NULL CHECK(unit_cents > 0),
 PRIMARY KEY(offer_id, inventory_id)
);
CREATE TABLE public.commerce_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL REFERENCES public.commerce_requests,
 buyer_id uuid NOT NULL REFERENCES public.commerce_actors, offer_id uuid NOT NULL REFERENCES public.commerce_offers,
 seller_id uuid NOT NULL REFERENCES public.commerce_sellers, offer_version integer NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 total_cents integer NOT NULL CHECK(total_cents > 0), currency text NOT NULL CHECK(currency='usd'),
 status text NOT NULL DEFAULT 'held' CHECK(status IN ('held','checkout_open','payment_pending','consumed','expired','failed')),
 expires_at timestamptz NOT NULL, checkout_expires_at bigint,
 stripe_session_id text UNIQUE, checkout_url text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(buyer_id,idempotency_key)
);
CREATE UNIQUE INDEX commerce_active_reservation ON public.commerce_reservations(request_id)
 WHERE status IN ('held','checkout_open','payment_pending','consumed');
CREATE TABLE public.commerce_reservation_items (
 reservation_id uuid NOT NULL REFERENCES public.commerce_reservations,
 inventory_id uuid NOT NULL REFERENCES public.commerce_inventory,
 title text NOT NULL, quantity integer NOT NULL CHECK(quantity > 0), unit_cents integer NOT NULL CHECK(unit_cents > 0),
 PRIMARY KEY(reservation_id,inventory_id)
);
CREATE TABLE public.commerce_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reservation_id uuid NOT NULL UNIQUE REFERENCES public.commerce_reservations,
 buyer_id uuid NOT NULL REFERENCES public.commerce_actors, seller_id uuid NOT NULL REFERENCES public.commerce_sellers,
 total_cents integer NOT NULL, currency text NOT NULL, stripe_session_id text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'confirmed' CHECK(status='confirmed'), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.commerce_payment_events (
 event_id text PRIMARY KEY, session_id text NOT NULL, event_type text NOT NULL, processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.commerce_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL, aggregate_id uuid NOT NULL,
 payload jsonb NOT NULL, delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(kind,aggregate_id)
);

CREATE FUNCTION public.commerce_reserve(p_buyer uuid, p_offer uuid, p_key text)
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
   IF r.offer_id<>p_offer THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
   RETURN to_jsonb(r);
 END IF;
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

CREATE FUNCTION public.commerce_begin_checkout(p_buyer uuid,p_reservation uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.commerce_reservations;
BEGIN
 SELECT * INTO r FROM public.commerce_reservations WHERE id=p_reservation FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'reservation_not_found'; END IF;
 IF r.buyer_id<>p_buyer THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF r.status NOT IN ('held','checkout_open') THEN RAISE EXCEPTION 'reservation_not_payable'; END IF;
 IF r.checkout_expires_at IS NULL THEN
   IF r.expires_at < now()+interval '33 minutes' THEN RAISE EXCEPTION 'reservation_expired'; END IF;
   UPDATE public.commerce_reservations SET checkout_expires_at=floor(extract(epoch FROM now()))::bigint+1920
   WHERE id=r.id RETURNING * INTO r;
 END IF;
 RETURN to_jsonb(r);
END $$;

CREATE FUNCTION public.commerce_bind_checkout(p_reservation uuid,p_session text,p_url text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.commerce_reservations;
BEGIN
 SELECT * INTO r FROM public.commerce_reservations WHERE id=p_reservation FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'reservation_not_found'; END IF;
 IF r.stripe_session_id IS NOT NULL AND r.stripe_session_id<>p_session THEN RAISE EXCEPTION 'session_conflict'; END IF;
 IF r.status NOT IN ('held','checkout_open') THEN RAISE EXCEPTION 'reservation_not_payable'; END IF;
 UPDATE public.commerce_reservations SET stripe_session_id=p_session,checkout_url=p_url,status='checkout_open'
 WHERE id=r.id RETURNING * INTO r;
 RETURN to_jsonb(r);
END $$;

CREATE FUNCTION public.commerce_apply_payment(p_event text,p_type text,p_reservation uuid,p_session text,
 p_total integer,p_currency text,p_paid boolean,p_release boolean,p_pending boolean)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.commerce_reservations; ord public.commerce_orders; item record;
BEGIN
 SELECT * INTO r FROM public.commerce_reservations WHERE id=p_reservation FOR UPDATE;
 IF NOT FOUND OR r.stripe_session_id IS DISTINCT FROM p_session THEN RAISE EXCEPTION 'session_mismatch'; END IF;
 IF r.total_cents<>p_total OR r.currency<>p_currency THEN RAISE EXCEPTION 'payment_mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM public.commerce_payment_events WHERE event_id=p_event) THEN
   RETURN jsonb_build_object('duplicate',true); END IF;
 IF p_paid THEN
   IF r.status IN ('expired','failed') THEN RAISE EXCEPTION 'payment_requires_reconciliation'; END IF;
   IF r.status<>'consumed' THEN
     INSERT INTO public.commerce_orders(reservation_id,buyer_id,seller_id,total_cents,currency,stripe_session_id)
     VALUES(r.id,r.buyer_id,r.seller_id,r.total_cents,r.currency,p_session) RETURNING * INTO ord;
     UPDATE public.commerce_inventory i SET sold=i.sold+ri.quantity FROM public.commerce_reservation_items ri
       WHERE ri.reservation_id=r.id AND ri.inventory_id=i.id;
     UPDATE public.commerce_reservations SET status='consumed' WHERE id=r.id;
     UPDATE public.commerce_requests SET status='confirmed' WHERE id=r.request_id;
     INSERT INTO public.commerce_outbox(kind,aggregate_id,payload)
       VALUES('order.confirmed',ord.id,jsonb_build_object('order_id',ord.id,'reservation_id',r.id));
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

-- Explicit deny-by-default for anonymous and logged-in SDK clients. Only our
-- trusted server calls these RPCs after checking its scoped demo principal.
DO $$ DECLARE t text; f record; BEGIN
 FOREACH t IN ARRAY ARRAY['commerce_actors','commerce_sellers','commerce_inventory','commerce_requests','commerce_offers',
 'commerce_offer_items','commerce_reservations','commerce_reservation_items','commerce_orders','commerce_payment_events','commerce_outbox'] LOOP
   EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated',t);
 END LOOP;
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname IN ('commerce_reserve','commerce_begin_checkout','commerce_bind_checkout','commerce_apply_payment') LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.signature);
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO project_admin',f.signature);
 END LOOP;
END $$;
CREATE INDEX commerce_offer_items_inventory ON public.commerce_offer_items(inventory_id);
CREATE INDEX commerce_reservations_buyer ON public.commerce_reservations(buyer_id);
CREATE INDEX commerce_orders_buyer ON public.commerce_orders(buyer_id);
CREATE INDEX commerce_orders_seller ON public.commerce_orders(seller_id);
