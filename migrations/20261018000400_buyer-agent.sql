-- Platform buyer agent (backend/API.md, "Buyer agent"). Additive only. One `buyer_agent`
-- principal negotiates every request whose buyer left delegate_negotiation on, acting as
-- that request's buyer: read the buyer view (plus the buyer's email), counter and decline.
-- It can never create, list, reserve or pay. backend/scripts/agent-tokens.ts mints its token.

-- 1. New principal scope. The seller_id rule is unchanged: only seller principals carry one.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.commerce_principals'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%''worker''%' AND pg_get_constraintdef(oid) NOT LIKE '%seller_id%' LOOP
   EXECUTE format('ALTER TABLE public.commerce_principals DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE public.commerce_principals ADD CONSTRAINT commerce_principals_scope_check
 CHECK(scope IN ('buyer','buyer_agent','seller','worker'));

-- 2. The buyer the agent may act for: the request's buyer iff delegate_negotiation is on.
-- Pass a request ID or a session ID. Unknown IDs raise the same not-found codes the buyer
-- routes use; an existing request that is not delegated raises 'forbidden', exactly like a
-- buyer reading someone else's request.
CREATE FUNCTION public.commerce_delegated_buyer(p_request uuid, p_session uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE q public.commerce_requests; req uuid := p_request;
BEGIN
 IF (p_request IS NULL) = (p_session IS NULL) THEN RAISE EXCEPTION 'invalid_input'; END IF;
 IF p_session IS NOT NULL THEN
   SELECT request_id INTO req FROM public.commerce_sessions WHERE id=p_session;
   IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found'; END IF;
 END IF;
 SELECT * INTO q FROM public.commerce_requests WHERE id=req;
 IF NOT FOUND THEN RAISE EXCEPTION 'request_not_found'; END IF;
 IF NOT q.delegate_negotiation THEN RAISE EXCEPTION 'forbidden'; END IF;
 RETURN jsonb_build_object('request_id',q.id,'buyer_id',q.buyer_id);
END $$;

-- 2b. The delegated request's buyer email, for the buyer agent only (GET /buy-requests/:id),
-- so it can tell the human a deal is ready to reserve. InsForge keeps accounts in auth.users,
-- which the admin API role cannot read: this narrow definer function returns one address,
-- only for a delegated request. Demo actors have no auth user, so email is null.
CREATE FUNCTION public.commerce_delegated_buyer_email(p_request uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE q public.commerce_requests; addr text;
BEGIN
 SELECT * INTO q FROM public.commerce_requests WHERE id=p_request;
 IF NOT FOUND THEN RAISE EXCEPTION 'request_not_found'; END IF;
 IF NOT q.delegate_negotiation THEN RAISE EXCEPTION 'forbidden'; END IF;
 SELECT u.email INTO addr FROM public.commerce_actors a JOIN auth.users u ON u.id=a.auth_user_id WHERE a.id=q.buyer_id;
 RETURN jsonb_build_object('request_id',q.id,'email',nullif(trim(addr),''));
END $$;

-- 3. Token rotation for scripts/agent-tokens.ts, in one transaction: revoke every earlier
-- `agents:%` principal, then insert the new ones (sha256 hashes only). Seed (`seed:%`) and
-- every other principal is never touched.
CREATE FUNCTION public.commerce_rotate_agent_principals(p_principals jsonb, p_hours integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE revoked integer; minted integer;
BEGIN
 IF p_hours IS NULL OR p_hours NOT BETWEEN 1 AND 8760 OR jsonb_typeof(p_principals) IS DISTINCT FROM 'array'
   OR jsonb_array_length(p_principals) NOT BETWEEN 1 AND 50
   OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_principals) e
    WHERE jsonb_typeof(e) <> 'object' OR coalesce(e->>'label','') NOT LIKE 'agents:%'
     OR coalesce(e->>'scope','') NOT IN ('buyer_agent','seller','worker')) THEN
   RAISE EXCEPTION 'invalid_input'; END IF;
 UPDATE public.commerce_principals SET revoked_at=now() WHERE label LIKE 'agents:%' AND revoked_at IS NULL;
 GET DIAGNOSTICS revoked = ROW_COUNT;
 INSERT INTO public.commerce_principals(token_hash,actor_id,scope,seller_id,label,expires_at)
 SELECT e->>'token_hash',(e->>'actor_id')::uuid,e->>'scope',(e->>'seller_id')::uuid,e->>'label',now()+make_interval(hours=>p_hours)
 FROM jsonb_array_elements(p_principals) e;
 GET DIAGNOSTICS minted = ROW_COUNT;
 RETURN jsonb_build_object('revoked',revoked,'minted',minted,'expires_at',now()+make_interval(hours=>p_hours));
END $$;

-- 4. Worker feed: route.delegated is the request's delegate_negotiation, so the runner knows
-- whether the platform buyer agent negotiates this request. Otherwise unchanged.
CREATE OR REPLACE FUNCTION public.commerce_worker_events(p_limit integer)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,'created_at',e.created_at,'payload',e.payload,
  'route',jsonb_strip_nulls(jsonb_build_object('to_role',e.to_role,'request_id',e.request_id,'seller_id',e.seller_id,
   'buyer_id',e.buyer_id,'agent_handle',e.agent_handle,'delegated',e.delegated))) ORDER BY e.created_at, e.id),'[]'::jsonb)
 FROM (SELECT o.id, o.kind, o.created_at, o.payload, q.id AS request_id, sl.id AS seller_id, q.buyer_id, sl.agent_handle,
   q.delegate_negotiation AS delegated,
   CASE WHEN o.kind='offer.created' OR (o.kind='session.declined' AND s.declined_by='seller') THEN 'buyer' ELSE 'seller' END AS to_role
  FROM public.commerce_outbox o
  JOIN public.commerce_sessions s ON s.id=(o.payload->>'session_id')::uuid
  JOIN public.commerce_requests q ON q.id=s.request_id JOIN public.commerce_sellers sl ON sl.id=s.seller_id
  WHERE o.delivered_at IS NULL AND o.kind IN ('session.opened','offer.created','counter.created','session.declined')
  ORDER BY o.created_at, o.id LIMIT least(greatest(coalesce(p_limit,20),1),100)) e
$$;

DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname IN ('commerce_delegated_buyer','commerce_delegated_buyer_email','commerce_rotate_agent_principals',
   'commerce_worker_events') LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.signature);
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO project_admin',f.signature);
 END LOOP;
END $$;
