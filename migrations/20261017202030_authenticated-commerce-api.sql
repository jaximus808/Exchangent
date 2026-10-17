ALTER TABLE public.commerce_requests ADD COLUMN requirements text NOT NULL DEFAULT '' CHECK(length(requirements)<=4000);
ALTER TABLE public.commerce_requests ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX commerce_requests_buyer_created ON public.commerce_requests(buyer_id,created_at DESC,id);

CREATE TABLE public.commerce_delegations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES public.commerce_actors,
 token_hash text NOT NULL UNIQUE CHECK(length(token_hash)=64),
 request_id uuid REFERENCES public.commerce_requests, seller_id uuid REFERENCES public.commerce_sellers,
 scopes text[] NOT NULL CHECK(cardinality(scopes)>0),
 expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((request_id IS NOT NULL)::integer+(seller_id IS NOT NULL)::integer=1),
 CHECK(scopes <@ ARRAY['request:read','reservation:write','checkout:write','seller:read']::text[]),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours')
);
ALTER TABLE public.commerce_delegations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.commerce_delegations FROM PUBLIC,anon,authenticated;
CREATE INDEX commerce_delegations_actor ON public.commerce_delegations(actor_id);

CREATE FUNCTION public.commerce_actor_for_user(p_user uuid,p_label text)
RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog,public,pg_temp AS $$
DECLARE actor uuid;
BEGIN
 IF p_user IS NULL THEN RAISE EXCEPTION 'unauthorized'; END IF;
 INSERT INTO public.commerce_actors(auth_user_id,label,is_demo)
 VALUES(p_user,left(p_label,80),false) ON CONFLICT(auth_user_id) DO NOTHING;
 SELECT id INTO actor FROM public.commerce_actors WHERE auth_user_id=p_user;
 RETURN actor;
END $$;
REVOKE ALL ON FUNCTION public.commerce_actor_for_user(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_actor_for_user(uuid,text) TO project_admin;
ALTER TABLE public.commerce_requests ADD COLUMN creation_key text CHECK(length(creation_key) BETWEEN 1 AND 200);
CREATE UNIQUE INDEX commerce_request_creation ON public.commerce_requests(buyer_id,creation_key);
CREATE FUNCTION public.commerce_create_request(p_buyer uuid,p_key text,p_requirements text,p_budget integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.commerce_requests;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.commerce_actors WHERE id=p_buyer AND NOT is_demo) THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF p_requirements IS NULL OR length(trim(p_requirements))=0 OR p_key IS NULL THEN RAISE EXCEPTION 'invalid_input'; END IF;
 INSERT INTO public.commerce_requests(buyer_id,budget_cents,requirements,creation_key)
 VALUES(p_buyer,p_budget,p_requirements,p_key) ON CONFLICT(buyer_id,creation_key) DO NOTHING;
 SELECT * INTO q FROM public.commerce_requests WHERE buyer_id=p_buyer AND creation_key=p_key;
 IF q.requirements<>p_requirements OR q.budget_cents<>p_budget THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
 INSERT INTO public.commerce_outbox(kind,aggregate_id,payload)
 VALUES('request.created',q.id,jsonb_build_object('request_id',q.id)) ON CONFLICT(kind,aggregate_id) DO NOTHING;
 RETURN jsonb_build_object('id',q.id,'requirements',q.requirements,'status',q.status,'currency',q.currency,'created_at',q.created_at);
END $$;
REVOKE ALL ON FUNCTION public.commerce_create_request(uuid,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_create_request(uuid,text,text,integer) TO project_admin;
