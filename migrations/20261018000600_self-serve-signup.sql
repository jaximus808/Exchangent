-- Self-serve sign-up and seller agents (doc/signup-contract.md). Additive only. Any signed-in
-- person registers a business, stocks it, and leaves "let my agent negotiate" on
-- (delegate_negotiation) so the platform seller agent can negotiate for it with a short-lived
-- seller token the worker mints. Floors stay seller-only; no outbox payload carries one.

-- 1. Business settings. New and renamed businesses get a name no other business has
-- (case-insensitive; agent handles are slugs of it). Existing rows already share names (test
-- sellers), so there is no unique index: register/update take a per-name advisory lock instead.
ALTER TABLE public.commerce_sellers
 ADD COLUMN delegate_negotiation boolean NOT NULL DEFAULT true,
 ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX commerce_sellers_owner ON public.commerce_sellers(owner_id);

-- 2. The owner's (and the seller agent's) view of one business. InsForge keeps accounts in
-- auth.users, which the admin API role cannot read: this definer function returns only the
-- owner's own address. Demo actors have no auth user, so owner_email is null.
CREATE FUNCTION public.commerce_business_json(p_seller uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE sl public.commerce_sellers; addr text;
BEGIN
 SELECT * INTO sl FROM public.commerce_sellers WHERE id=p_seller;
 IF NOT FOUND THEN RAISE EXCEPTION 'seller_not_found'; END IF;
 SELECT u.email INTO addr FROM public.commerce_actors a JOIN auth.users u ON u.id=a.auth_user_id WHERE a.id=sl.owner_id;
 RETURN jsonb_build_object('seller_id',sl.id,'name',sl.name,'service_area',sl.service_area,'delivery_cents',sl.delivery_cents,
  'delivery_days',sl.delivery_days,'delegate_negotiation',sl.delegate_negotiation,'enabled',sl.enabled,
  'agent_handle',sl.agent_handle,'created_at',sl.created_at,'owner_email',nullif(trim(addr),''));
END $$;

-- Shared validation for register and update. NULL means "not given".
CREATE FUNCTION public.commerce_valid_business(p_name text, p_service_area text, p_delivery_cents integer, p_delivery_days integer)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT (p_name IS NULL OR length(trim(p_name)) BETWEEN 2 AND 80)
  AND (p_service_area IS NULL OR p_service_area ~ '^[a-z_]{2,40}$')
  AND (p_delivery_cents IS NULL OR p_delivery_cents BETWEEN 0 AND 100000)
  AND (p_delivery_days IS NULL OR p_delivery_days BETWEEN 0 AND 30)
$$;

-- 3. Register a business owned by p_actor (at most 5 per actor).
CREATE FUNCTION public.commerce_register_business(p_actor uuid, p_name text, p_service_area text,
 p_delivery_cents integer, p_delivery_days integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE sl public.commerce_sellers; nm text := trim(p_name);
BEGIN
 IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.commerce_actors WHERE id=p_actor) THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF nm IS NULL OR NOT public.commerce_valid_business(nm,p_service_area,p_delivery_cents,p_delivery_days) THEN
   RAISE EXCEPTION 'invalid_input'; END IF;
 -- Serialize one actor's registrations so the limit holds under concurrency.
 PERFORM 1 FROM public.commerce_actors WHERE id=p_actor FOR UPDATE;
 IF (SELECT count(*) FROM public.commerce_sellers WHERE owner_id=p_actor) >= 5 THEN RAISE EXCEPTION 'business_limit'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('commerce_business_name:'||lower(nm)));
 IF EXISTS (SELECT 1 FROM public.commerce_sellers WHERE lower(trim(name))=lower(nm)) THEN RAISE EXCEPTION 'business_name_taken'; END IF;
 INSERT INTO public.commerce_sellers(owner_id,name,service_area,delivery_cents,delivery_days)
 VALUES(p_actor,nm,coalesce(p_service_area,'san_francisco'),coalesce(p_delivery_cents,0),coalesce(p_delivery_days,2))
 RETURNING * INTO sl;
 RETURN public.commerce_business_json(sl.id);
END $$;

-- 4. Owner settings. Turning delegation off revokes the seller agent's tokens at once.
CREATE FUNCTION public.commerce_update_business(p_seller uuid, p_patch jsonb)
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
  nm := trim(p_patch->>'name'); area := p_patch->>'service_area';
  fee := (p_patch->>'delivery_cents')::integer; days := (p_patch->>'delivery_days')::integer;
  delegate := (p_patch->>'delegate_negotiation')::boolean;
 EXCEPTION WHEN others THEN RAISE EXCEPTION 'invalid_input';
 END;
 IF fee::numeric IS DISTINCT FROM (p_patch->>'delivery_cents')::numeric
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

-- 5. Stock one item, inserted or updated by (seller, sku). No outbox row: inventory is private.
CREATE FUNCTION public.commerce_upsert_inventory(p_seller uuid, p_item jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE i public.commerce_inventory; v_sku text; v_title text; v_cat text; v_attrs jsonb; v_list integer; v_floor integer; v_avail integer;
BEGIN
 IF jsonb_typeof(p_item) IS DISTINCT FROM 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_item) k
   WHERE k NOT IN ('sku','title','category','attributes','list_cents','floor_cents','available')) THEN
   RAISE EXCEPTION 'invalid_input'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.commerce_sellers WHERE id=p_seller) THEN RAISE EXCEPTION 'seller_not_found'; END IF;
 IF jsonb_typeof(p_item->'title') IS DISTINCT FROM 'string' OR jsonb_typeof(p_item->'category') IS DISTINCT FROM 'string'
   OR (p_item ? 'sku' AND jsonb_typeof(p_item->'sku') NOT IN ('string','null'))
   OR (p_item ? 'attributes' AND jsonb_typeof(p_item->'attributes') NOT IN ('object','null'))
   OR jsonb_typeof(p_item->'list_cents') IS DISTINCT FROM 'number' OR jsonb_typeof(p_item->'floor_cents') IS DISTINCT FROM 'number'
   OR jsonb_typeof(p_item->'available') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'invalid_input'; END IF;
 BEGIN
  v_list := (p_item->>'list_cents')::integer; v_floor := (p_item->>'floor_cents')::integer; v_avail := (p_item->>'available')::integer;
 EXCEPTION WHEN others THEN RAISE EXCEPTION 'invalid_input';
 END;
 v_title := trim(p_item->>'title'); v_cat := p_item->>'category';
 v_attrs := coalesce(nullif(p_item->'attributes','null'::jsonb),'{}'::jsonb);
 v_sku := coalesce(nullif(trim(p_item->>'sku'),''),
  left(trim(both '-' from regexp_replace(lower(v_title),'[^a-z0-9]+','-','g')),60));
 IF length(v_title) NOT BETWEEN 1 AND 200 OR v_cat !~ '^[a-z_]{2,40}$' OR v_sku !~ '^[A-Za-z0-9._-]{1,60}$'
   OR length(v_attrs::text) > 2000 OR v_list::numeric <> (p_item->>'list_cents')::numeric
   OR v_floor::numeric <> (p_item->>'floor_cents')::numeric OR v_avail::numeric <> (p_item->>'available')::numeric
   OR v_list < 1 OR v_list > 100000000 OR v_floor < 1 OR v_floor > v_list OR v_avail < 0 OR v_avail > 100000 THEN
   RAISE EXCEPTION 'invalid_input'; END IF;
 INSERT INTO public.commerce_inventory(seller_id,sku,title,category,attributes,list_cents,floor_cents,available)
 VALUES(p_seller,v_sku,v_title,v_cat,v_attrs,v_list,v_floor,v_avail)
 ON CONFLICT(seller_id,sku) DO UPDATE SET title=EXCLUDED.title, category=EXCLUDED.category, attributes=EXCLUDED.attributes,
  list_cents=EXCLUDED.list_cents, floor_cents=EXCLUDED.floor_cents, available=EXCLUDED.available
 RETURNING * INTO i;
 RETURN jsonb_build_object('inventory_id',i.id,'sku',i.sku,'title',i.title,'category',i.category,'attributes',i.attributes,
  'list_cents',i.list_cents,'floor_cents',i.floor_cents,'available',i.available,'sold',i.sold);
END $$;

-- 6. A short-lived seller token for the platform seller agent (POST /worker/sellers/:id/token),
-- only while the owner leaves delegation on. It acts as the business's current owner, like
-- the agent-tokens script; only the sha256 hash is stored.
CREATE FUNCTION public.commerce_mint_seller_agent_token(p_seller uuid, p_token_hash text, p_hours integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE sl public.commerce_sellers; p public.commerce_principals;
BEGIN
 IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR coalesce(p_hours,24) NOT BETWEEN 1 AND 72 THEN
   RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO sl FROM public.commerce_sellers WHERE id=p_seller;
 IF NOT FOUND THEN RAISE EXCEPTION 'seller_not_found'; END IF;
 IF NOT (sl.enabled AND sl.delegate_negotiation) THEN RAISE EXCEPTION 'not_delegated'; END IF;
 INSERT INTO public.commerce_principals(token_hash,actor_id,scope,seller_id,label,expires_at)
 VALUES(p_token_hash,sl.owner_id,'seller',sl.id,'agents:seller-agent:'||sl.id,now()+make_interval(hours=>coalesce(p_hours,24)))
 RETURNING * INTO p;
 RETURN jsonb_build_object('seller_id',sl.id,'name',sl.name,'expires_at',p.expires_at,'agent_handle',sl.agent_handle);
END $$;

-- 7. A sale notice for the seller agent. The 'order.confirmed' outbox row belongs to the buyer's
-- receipt email (its delivered_at), so the seller gets its own row, written with the order. The
-- worker feed shows it as kind 'order.confirmed'. No buyer email, budget or floor.
CREATE FUNCTION public.commerce_order_seller_notice()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
 INSERT INTO public.commerce_outbox(kind,aggregate_id,payload)
 SELECT 'order.confirmed.seller',NEW.id,jsonb_build_object('order_id',NEW.id,'reservation_id',NEW.reservation_id,
  'request_id',r.request_id,'seller_id',NEW.seller_id,'total_cents',NEW.total_cents,'currency',NEW.currency,'title',q.title)
 FROM public.commerce_reservations r JOIN public.commerce_requests q ON q.id=r.request_id WHERE r.id=NEW.reservation_id
 ON CONFLICT(kind,aggregate_id) DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_orders_seller_notice AFTER INSERT ON public.commerce_orders
 FOR EACH ROW EXECUTE FUNCTION public.commerce_order_seller_notice();

-- 8. Worker feed: unchanged negotiation events plus route.seller_delegated, and sale notices.
CREATE OR REPLACE FUNCTION public.commerce_worker_events(p_limit integer)
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
   WHERE o.delivered_at IS NULL AND o.kind IN ('session.opened','offer.created','counter.created','session.declined')
  UNION ALL
   SELECT o.id, 'order.confirmed', o.created_at, o.payload, q.id, sl.id, q.buyer_id, sl.agent_handle,
    q.delegate_negotiation, sl.delegate_negotiation, 'seller'
   FROM public.commerce_outbox o
   JOIN public.commerce_orders ord ON ord.id=o.aggregate_id
   JOIN public.commerce_reservations r ON r.id=ord.reservation_id
   JOIN public.commerce_requests q ON q.id=r.request_id JOIN public.commerce_sellers sl ON sl.id=ord.seller_id
   WHERE o.delivered_at IS NULL AND o.kind='order.confirmed.seller'
  ) u ORDER BY u.created_at, u.id LIMIT least(greatest(coalesce(p_limit,20),1),100)) e
$$;

-- Ack accepts the sale notice too, never the receipt email's 'order.confirmed' row.
CREATE OR REPLACE FUNCTION public.commerce_ack_event(p_event uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE e public.commerce_outbox;
BEGIN
 UPDATE public.commerce_outbox SET delivered_at=coalesce(delivered_at,now())
 WHERE id=p_event AND kind IN ('session.opened','offer.created','counter.created','session.declined','order.confirmed.seller')
 RETURNING * INTO e;
 IF NOT FOUND THEN RAISE EXCEPTION 'event_not_found'; END IF;
 RETURN jsonb_build_object('id',e.id,'kind',CASE WHEN e.kind='order.confirmed.seller' THEN 'order.confirmed' ELSE e.kind END,
  'delivered_at',e.delivered_at);
END $$;

DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname IN ('commerce_business_json','commerce_valid_business','commerce_register_business',
   'commerce_update_business','commerce_upsert_inventory','commerce_mint_seller_agent_token','commerce_order_seller_notice',
   'commerce_worker_events','commerce_ack_event') LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.signature);
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO project_admin',f.signature);
 END LOOP;
END $$;
