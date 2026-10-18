-- Agent conversation visibility (doc/conversation-contract.md). Additive only. The runner reports how
-- each outbox event was delivered (Inkbox A2A or in-process) when it acks it; the conversation reads
-- join those receipts to the offers, counters and declines they announced. Conversation JSON never
-- carries floors, budgets, targets, line items or buyer email.

-- 1. Delivery receipt on the event that announced a move. NULL until the runner reports one.
ALTER TABLE public.commerce_outbox ADD COLUMN delivery jsonb CHECK(delivery IS NULL OR jsonb_typeof(delivery)='object');

-- 2. Ack with an optional receipt. Only allowlisted string keys are kept; the first receipt wins
-- (a retried ack resends the same one). Replaces the one-argument version.
DROP FUNCTION public.commerce_ack_event(uuid);
CREATE FUNCTION public.commerce_ack_event(p_event uuid, p_delivery jsonb DEFAULT NULL)
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
 WHERE id=p_event AND kind IN ('session.opened','offer.created','counter.created','session.declined','order.confirmed.seller')
 RETURNING * INTO e;
 IF NOT FOUND THEN RAISE EXCEPTION 'event_not_found'; END IF;
 RETURN jsonb_build_object('id',e.id,'kind',CASE WHEN e.kind='order.confirmed.seller' THEN 'order.confirmed' ELSE e.kind END,
  'delivered_at',e.delivered_at);
END $$;

-- 3. One session's moves in order: opened (platform), seller offers, buyer counters, a decline. Each
-- carries the receipt of the outbox event that announced it (aggregate: session, offer or counter).
CREATE FUNCTION public.commerce_session_messages(p_session uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT coalesce(jsonb_agg(m.msg ORDER BY m.at, m.v, m.ord),'[]'::jsonb) FROM (
  SELECT s.created_at AS at, 0 AS v, 0 AS ord, jsonb_strip_nulls(jsonb_build_object('kind','opened','by','platform','at',s.created_at,
   'delivery',(SELECT x.delivery FROM public.commerce_outbox x WHERE x.kind='session.opened' AND x.aggregate_id=s.id))) AS msg
  FROM public.commerce_sessions s WHERE s.id=p_session
  UNION ALL
  SELECT o.created_at, o.session_version, 1, jsonb_strip_nulls(jsonb_build_object('kind','offer','by','seller',
   'total_cents',(SELECT coalesce(sum(oi.quantity::bigint*oi.unit_cents),0) FROM public.commerce_offer_items oi WHERE oi.offer_id=o.id)
    +o.delivery_cents+o.tax_cents,
   'note',o.note,'version',o.session_version,'offer_id',o.id,'at',o.created_at,
   'delivery',(SELECT x.delivery FROM public.commerce_outbox x WHERE x.kind='offer.created' AND x.aggregate_id=o.id)))
  FROM public.commerce_offers o WHERE o.session_id=p_session
  UNION ALL
  SELECT c.created_at, c.version, 2, jsonb_strip_nulls(jsonb_build_object('kind','counter','by','buyer','total_cents',c.total_cents,
   'note',c.note,'version',c.version,'counter_id',c.id,'at',c.created_at,
   'delivery',(SELECT x.delivery FROM public.commerce_outbox x WHERE x.kind='counter.created' AND x.aggregate_id=c.id)))
  FROM public.commerce_counters c WHERE c.session_id=p_session
  UNION ALL
  SELECT coalesce(x.created_at,s.updated_at), s.version, 3, jsonb_strip_nulls(jsonb_build_object('kind','declined',
   'by',s.declined_by,'reason',s.decline_reason,'version',s.version,'at',coalesce(x.created_at,s.updated_at),'delivery',x.delivery))
  FROM public.commerce_sessions s LEFT JOIN public.commerce_outbox x ON x.kind='session.declined' AND x.aggregate_id=s.id
  WHERE s.id=p_session AND s.status='declined'
 ) m
$$;

-- 4. One session for a conversation view: who negotiates for the seller, the current open offer, the moves.
CREATE FUNCTION public.commerce_session_conversation(p_session uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT jsonb_build_object('session_id',s.id,'request_id',s.request_id,'seller_id',sl.id,'seller_name',sl.name,
  'status',s.status,'turn',s.turn,'rounds',s.rounds,'seller_agent',sl.delegate_negotiation,'seller_handle',sl.agent_handle,
  'opened_at',s.created_at,
  'current_offer',CASE WHEN s.status='open' THEN (SELECT jsonb_build_object('offer_id',o.id,'total_cents',
    (SELECT coalesce(sum(oi.quantity::bigint*oi.unit_cents),0) FROM public.commerce_offer_items oi WHERE oi.offer_id=o.id)
     +o.delivery_cents+o.tax_cents,'expires_at',o.expires_at)
   FROM public.commerce_offers o WHERE o.id=s.latest_offer_id AND o.is_current) END,
  'messages',public.commerce_session_messages(s.id))
 FROM public.commerce_sessions s JOIN public.commerce_sellers sl ON sl.id=s.seller_id WHERE s.id=p_session
$$;

-- 5. A request's whole conversation for its buyer (the backend checks access first).
CREATE FUNCTION public.commerce_conversation(p_request uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT jsonb_build_object('request_id',q.id,'title',q.title,'status',q.status,'delegate_negotiation',q.delegate_negotiation,
  'created_at',q.created_at,'sessions',coalesce(c.sessions,'[]'::jsonb),
  'best_offer',(SELECT jsonb_build_object('session_id',e->>'session_id','seller_name',e->>'seller_name',
    'offer_id',e->'current_offer'->>'offer_id','total_cents',(e->'current_offer'->>'total_cents')::bigint)
   FROM jsonb_array_elements(c.sessions) e WHERE e->'current_offer' IS NOT NULL AND e->'current_offer' <> 'null'::jsonb
   ORDER BY (e->'current_offer'->>'total_cents')::bigint, e->>'seller_name' LIMIT 1),
  'reservation',(SELECT jsonb_build_object('reservation_id',r.id,'offer_id',r.offer_id,'seller_id',r.seller_id,'status',r.status,
    'total_cents',r.total_cents) FROM public.commerce_reservations r
   WHERE r.request_id=q.id AND r.status IN ('held','checkout_open','payment_pending','consumed') LIMIT 1))
 FROM public.commerce_requests q
 LEFT JOIN LATERAL (SELECT jsonb_agg(public.commerce_session_conversation(s.id) ORDER BY sl.name, s.id) AS sessions
  FROM public.commerce_sessions s JOIN public.commerce_sellers sl ON sl.id=s.seller_id WHERE s.request_id=q.id) c ON true
 WHERE q.id=p_request
$$;

-- 6. The signed-in buyer's requests for the web dashboard. The buyer's own budget and target are theirs to see.
CREATE FUNCTION public.commerce_buyer_requests(p_buyer uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT coalesce(jsonb_agg(x.r ORDER BY x.created_at DESC, x.id),'[]'::jsonb) FROM (
  SELECT q.id, q.created_at, jsonb_build_object('id',q.id,'request_id',q.id,'title',q.title,'requirements',q.requirements,
   'structured_requirements',q.structured_requirements,'status',q.status,'currency',q.currency,'created_at',q.created_at,
   'budget_cents',q.budget_cents,'target_cents',q.target_cents,'delegate_negotiation',q.delegate_negotiation,
   'seller_count',(SELECT count(*) FROM public.commerce_sessions s WHERE s.request_id=q.id),
   'open_sessions',(SELECT count(*) FROM public.commerce_sessions s WHERE s.request_id=q.id AND s.status='open'),
   'best_offer',(SELECT jsonb_build_object('offer_id',o.id,'seller_name',sl.name,'total_cents',
      (SELECT coalesce(sum(oi.quantity::bigint*oi.unit_cents),0) FROM public.commerce_offer_items oi WHERE oi.offer_id=o.id)
       +o.delivery_cents+o.tax_cents)
     FROM public.commerce_sessions s JOIN public.commerce_offers o ON o.id=s.latest_offer_id AND o.is_current
     JOIN public.commerce_sellers sl ON sl.id=s.seller_id
     WHERE s.request_id=q.id AND s.status='open'
     ORDER BY (SELECT coalesce(sum(oi.quantity::bigint*oi.unit_cents),0) FROM public.commerce_offer_items oi WHERE oi.offer_id=o.id)
       +o.delivery_cents+o.tax_cents, sl.name LIMIT 1),
   'reservation',(SELECT jsonb_build_object('reservation_id',r.id,'offer_id',r.offer_id,'status',r.status,'total_cents',r.total_cents)
     FROM public.commerce_reservations r WHERE r.request_id=q.id AND r.status IN ('held','checkout_open','payment_pending','consumed') LIMIT 1)
  ) AS r
  FROM public.commerce_requests q WHERE q.buyer_id=p_buyer ORDER BY q.created_at DESC, q.id LIMIT 50) x
$$;

-- 7. The signed-in person's businesses with their stock and a sales summary (owner view: floors included).
CREATE FUNCTION public.commerce_actor_businesses(p_actor uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT coalesce(jsonb_agg(public.commerce_business_json(sl.id) || jsonb_build_object(
   'inventory',public.commerce_seller_inventory(sl.id),
   'open_sessions',(SELECT count(*) FROM public.commerce_sessions s WHERE s.seller_id=sl.id AND s.status='open'),
   'orders',(SELECT count(*) FROM public.commerce_orders o WHERE o.seller_id=sl.id),
   'sales_cents',(SELECT coalesce(sum(o.total_cents),0) FROM public.commerce_orders o WHERE o.seller_id=sl.id))
  ORDER BY sl.created_at, sl.id),'[]'::jsonb)
 FROM public.commerce_sellers sl WHERE sl.owner_id=p_actor
$$;

-- 8. One business's negotiations, newest first, each with its own moves only (never other sellers').
-- The request summary has no budget, target or buyer.
CREATE FUNCTION public.commerce_business_sessions(p_seller uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT coalesce(jsonb_agg(public.commerce_session_conversation(s.id) || jsonb_build_object('request',jsonb_build_object(
   'request_id',q.id,'title',q.title,'status',q.status,'requirements',q.structured_requirements,'deadline',q.deadline,
   'created_at',q.created_at)) ORDER BY s.created_at DESC, s.id),'[]'::jsonb)
 FROM public.commerce_sessions s JOIN public.commerce_requests q ON q.id=s.request_id WHERE s.seller_id=p_seller
$$;

DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname IN ('commerce_ack_event','commerce_session_messages','commerce_session_conversation',
   'commerce_conversation','commerce_buyer_requests','commerce_actor_businesses','commerce_business_sessions') LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.signature);
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO project_admin',f.signature);
 END LOOP;
END $$;
