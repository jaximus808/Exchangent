-- Connector OAuth (doc/oauth-contract.md). Additive only. Exchangent is the OAuth
-- authorization server for the MCP proxy: the web consent page issues a single-use
-- code, the token endpoint exchanges it for an `exc_` access token and an `exr_`
-- refresh token bound to one actor and one role (buyer, or seller for one owned
-- business). Client secrets, codes and tokens are stored only as sha256 hex.
-- Redemption and rotation run inside one plpgsql transaction with a row lock, so
-- concurrent calls can never issue two token sets for one code or refresh token.
CREATE TABLE public.commerce_oauth_clients (
 client_id text PRIMARY KEY CHECK(client_id ~ '^[A-Za-z0-9._~-]{8,200}$'),
 secret_hash text NOT NULL CHECK(secret_hash ~ '^[0-9a-f]{64}$'),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 redirect_uris text[] NOT NULL CHECK(cardinality(redirect_uris) BETWEEN 1 AND 10),
 created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE TABLE public.commerce_oauth_codes (
 code_hash text PRIMARY KEY CHECK(code_hash ~ '^[0-9a-f]{64}$'),
 client_id text NOT NULL REFERENCES public.commerce_oauth_clients,
 actor_id uuid NOT NULL REFERENCES public.commerce_actors,
 kind text NOT NULL CHECK(kind IN ('buyer','seller')),
 seller_id uuid REFERENCES public.commerce_sellers,
 redirect_uri text NOT NULL, scope text NOT NULL DEFAULT '' CHECK(length(scope) <= 1024),
 -- PKCE is mandatory: the MCP proxy always sends an S256 challenge.
 code_challenge text NOT NULL CHECK(code_challenge ~ '^[A-Za-z0-9._~-]{43,128}$'),
 code_challenge_method text NOT NULL CHECK(code_challenge_method = 'S256'),
 expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind = 'seller') = (seller_id IS NOT NULL))
);
-- One row per issued token pair. Refresh rotation inserts a new row (rotated_from) in
-- the same family and marks the old row rotated; presenting a rotated refresh token
-- again revokes the whole family.
CREATE TABLE public.commerce_connector_grants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 family_id uuid NOT NULL DEFAULT gen_random_uuid(),
 client_id text NOT NULL REFERENCES public.commerce_oauth_clients,
 actor_id uuid NOT NULL REFERENCES public.commerce_actors,
 kind text NOT NULL CHECK(kind IN ('buyer','seller')),
 seller_id uuid REFERENCES public.commerce_sellers,
 access_hash text NOT NULL UNIQUE CHECK(access_hash ~ '^[0-9a-f]{64}$'),
 refresh_hash text NOT NULL UNIQUE CHECK(refresh_hash ~ '^[0-9a-f]{64}$'),
 access_expires_at timestamptz NOT NULL, refresh_expires_at timestamptz NOT NULL,
 revoked_at timestamptz, rotated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 rotated_from uuid REFERENCES public.commerce_connector_grants,
 code_hash text,
 CHECK((kind = 'seller') = (seller_id IS NOT NULL))
);
CREATE INDEX commerce_connector_grants_family ON public.commerce_connector_grants(family_id);
CREATE INDEX commerce_connector_grants_actor ON public.commerce_connector_grants(actor_id);
CREATE INDEX commerce_connector_grants_code ON public.commerce_connector_grants(code_hash);
CREATE INDEX commerce_oauth_codes_expires ON public.commerce_oauth_codes(expires_at);

-- Create or update a client. A NULL secret hash keeps the stored secret (the client must exist).
CREATE FUNCTION public.commerce_oauth_upsert_client(p_client_id text, p_name text, p_redirect_uris jsonb, p_secret_hash text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE uris text[]; old public.commerce_oauth_clients; c public.commerce_oauth_clients;
BEGIN
 IF jsonb_typeof(p_redirect_uris) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid_input'; END IF;
 uris := ARRAY(SELECT jsonb_array_elements_text(p_redirect_uris));
 SELECT * INTO old FROM public.commerce_oauth_clients WHERE client_id=p_client_id FOR UPDATE;
 IF p_secret_hash IS NULL THEN
   IF NOT FOUND THEN RAISE EXCEPTION 'client_not_found'; END IF;
   UPDATE public.commerce_oauth_clients SET name=p_name, redirect_uris=uris, revoked_at=NULL
   WHERE client_id=p_client_id RETURNING * INTO c;
 ELSE
   INSERT INTO public.commerce_oauth_clients(client_id,secret_hash,name,redirect_uris)
   VALUES(p_client_id,p_secret_hash,p_name,uris)
   ON CONFLICT(client_id) DO UPDATE SET secret_hash=EXCLUDED.secret_hash, name=EXCLUDED.name,
    redirect_uris=EXCLUDED.redirect_uris, revoked_at=NULL
   RETURNING * INTO c;
 END IF;
 RETURN jsonb_build_object('client_id',c.client_id,'name',c.name,'redirect_uris',to_jsonb(c.redirect_uris),
  'created',old.client_id IS NULL,'secret_changed',old.secret_hash IS DISTINCT FROM c.secret_hash);
END $$;

-- What a signed-in actor may authorize for this client (consent screen).
CREATE FUNCTION public.commerce_oauth_targets(p_client_id text, p_redirect_uri text, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.commerce_oauth_clients;
BEGIN
 SELECT * INTO c FROM public.commerce_oauth_clients WHERE client_id=p_client_id AND revoked_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'invalid_client'; END IF;
 IF NOT coalesce(p_redirect_uri = ANY(c.redirect_uris), false) THEN RAISE EXCEPTION 'invalid_redirect_uri'; END IF;
 RETURN jsonb_build_object('client',jsonb_build_object('client_id',c.client_id,'name',c.name),
  'businesses',coalesce((SELECT jsonb_agg(jsonb_build_object('seller_id',s.id,'name',s.name) ORDER BY s.name, s.id)
   FROM public.commerce_sellers s WHERE s.owner_id=p_actor AND s.enabled),'[]'::jsonb));
END $$;

-- Consent approved: store a single-use code (5 minutes) after re-checking every binding.
CREATE FUNCTION public.commerce_oauth_issue_code(p_code_hash text, p_client_id text, p_redirect_uri text, p_actor uuid,
 p_kind text, p_seller uuid, p_scope text, p_code_challenge text, p_code_challenge_method text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.commerce_oauth_clients; code public.commerce_oauth_codes;
BEGIN
 SELECT * INTO c FROM public.commerce_oauth_clients WHERE client_id=p_client_id AND revoked_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'invalid_client'; END IF;
 IF NOT coalesce(p_redirect_uri = ANY(c.redirect_uris), false) THEN RAISE EXCEPTION 'invalid_redirect_uri'; END IF;
 IF p_kind IS NULL OR p_kind NOT IN ('buyer','seller') OR (p_kind = 'seller') <> (p_seller IS NOT NULL)
   OR p_code_challenge IS NULL OR p_code_challenge !~ '^[A-Za-z0-9._~-]{43,128}$'
   OR p_code_challenge_method IS DISTINCT FROM 'S256' OR length(p_scope) > 1024 THEN
   RAISE EXCEPTION 'invalid_request'; END IF;
 IF p_kind = 'seller' AND NOT EXISTS (SELECT 1 FROM public.commerce_sellers WHERE id=p_seller AND owner_id=p_actor AND enabled) THEN
   RAISE EXCEPTION 'forbidden'; END IF;
 -- Housekeeping: codes are useless a few minutes after issue.
 DELETE FROM public.commerce_oauth_codes WHERE expires_at < now() - interval '1 day';
 INSERT INTO public.commerce_oauth_codes(code_hash,client_id,actor_id,kind,seller_id,redirect_uri,scope,code_challenge,
  code_challenge_method,expires_at)
 VALUES(p_code_hash,p_client_id,p_actor,p_kind,p_seller,p_redirect_uri,coalesce(p_scope,''),p_code_challenge,
  p_code_challenge_method,now() + interval '5 minutes') RETURNING * INTO code;
 RETURN jsonb_build_object('expires_at',code.expires_at);
END $$;

-- Failures RETURN {error, reason} instead of raising so the replay revocations commit.
CREATE FUNCTION public.commerce_oauth_redeem_code(p_code_hash text, p_client_id text, p_redirect_uri text,
 p_code_challenge text, p_access_hash text, p_refresh_hash text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.commerce_oauth_codes; g public.commerce_connector_grants;
BEGIN
 SELECT * INTO c FROM public.commerce_oauth_codes WHERE code_hash=p_code_hash FOR UPDATE;
 IF NOT FOUND OR c.client_id IS DISTINCT FROM p_client_id THEN
   RETURN jsonb_build_object('error','invalid_grant','reason','unknown_code'); END IF;
 IF c.used_at IS NOT NULL THEN
   -- RFC 6749 section 4.1.2: a replayed code revokes the tokens it already issued.
   UPDATE public.commerce_connector_grants SET revoked_at=coalesce(revoked_at,now())
   WHERE family_id IN (SELECT family_id FROM public.commerce_connector_grants WHERE code_hash=c.code_hash);
   RETURN jsonb_build_object('error','invalid_grant','reason','code_reused');
 END IF;
 IF c.expires_at <= now() THEN RETURN jsonb_build_object('error','invalid_grant','reason','code_expired'); END IF;
 IF c.redirect_uri IS DISTINCT FROM p_redirect_uri THEN
   RETURN jsonb_build_object('error','invalid_grant','reason','redirect_uri_mismatch'); END IF;
 IF c.code_challenge IS DISTINCT FROM p_code_challenge THEN
   RETURN jsonb_build_object('error','invalid_grant','reason','pkce_mismatch'); END IF;
 IF NOT EXISTS (SELECT 1 FROM public.commerce_oauth_clients WHERE client_id=c.client_id AND revoked_at IS NULL) THEN
   RETURN jsonb_build_object('error','invalid_client','reason','client_revoked'); END IF;
 UPDATE public.commerce_oauth_codes SET used_at=now() WHERE code_hash=c.code_hash;
 IF c.kind = 'seller' AND NOT EXISTS (SELECT 1 FROM public.commerce_sellers WHERE id=c.seller_id AND owner_id=c.actor_id AND enabled) THEN
   RETURN jsonb_build_object('error','invalid_grant','reason','seller_access_lost'); END IF;
 INSERT INTO public.commerce_connector_grants(client_id,actor_id,kind,seller_id,access_hash,refresh_hash,
  access_expires_at,refresh_expires_at,code_hash)
 VALUES(c.client_id,c.actor_id,c.kind,c.seller_id,p_access_hash,p_refresh_hash,
  now() + interval '1 hour',now() + interval '30 days',c.code_hash) RETURNING * INTO g;
 RETURN jsonb_build_object('grant_id',g.id,'scope',g.kind,'actor_id',g.actor_id,'seller_id',g.seller_id,
  'expires_in',3600);
END $$;

CREATE FUNCTION public.commerce_oauth_refresh(p_refresh_hash text, p_client_id text, p_access_hash text, p_new_refresh_hash text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE g public.commerce_connector_grants; n public.commerce_connector_grants;
BEGIN
 SELECT * INTO g FROM public.commerce_connector_grants WHERE refresh_hash=p_refresh_hash FOR UPDATE;
 IF NOT FOUND OR g.client_id IS DISTINCT FROM p_client_id THEN
   RETURN jsonb_build_object('error','invalid_grant','reason','unknown_refresh_token'); END IF;
 IF g.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('error','invalid_grant','reason','grant_revoked'); END IF;
 IF g.rotated_at IS NOT NULL THEN
   -- Reuse of a rotated refresh token: assume theft and revoke every token in the family.
   UPDATE public.commerce_connector_grants SET revoked_at=coalesce(revoked_at,now()) WHERE family_id=g.family_id;
   RETURN jsonb_build_object('error','invalid_grant','reason','refresh_token_reused');
 END IF;
 IF g.refresh_expires_at <= now() THEN RETURN jsonb_build_object('error','invalid_grant','reason','refresh_token_expired'); END IF;
 IF NOT EXISTS (SELECT 1 FROM public.commerce_oauth_clients WHERE client_id=g.client_id AND revoked_at IS NULL) THEN
   RETURN jsonb_build_object('error','invalid_client','reason','client_revoked'); END IF;
 IF g.kind = 'seller' AND NOT EXISTS (SELECT 1 FROM public.commerce_sellers WHERE id=g.seller_id AND owner_id=g.actor_id AND enabled) THEN
   UPDATE public.commerce_connector_grants SET revoked_at=coalesce(revoked_at,now()) WHERE family_id=g.family_id;
   RETURN jsonb_build_object('error','invalid_grant','reason','seller_access_lost');
 END IF;
 UPDATE public.commerce_connector_grants SET rotated_at=now() WHERE id=g.id;
 INSERT INTO public.commerce_connector_grants(family_id,client_id,actor_id,kind,seller_id,access_hash,refresh_hash,
  access_expires_at,refresh_expires_at,rotated_from,code_hash)
 VALUES(g.family_id,g.client_id,g.actor_id,g.kind,g.seller_id,p_access_hash,p_new_refresh_hash,
  now() + interval '1 hour',now() + interval '30 days',g.id,g.code_hash) RETURNING * INTO n;
 RETURN jsonb_build_object('grant_id',n.id,'scope',n.kind,'actor_id',n.actor_id,'seller_id',n.seller_id,'expires_in',3600);
END $$;

-- Bearer exc_ token -> negotiation principal. Seller grants also require current ownership.
CREATE FUNCTION public.commerce_resolve_connector(p_token_hash text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT jsonb_build_object('kind','connector','scope',g.kind,'actor_id',g.actor_id,'seller_id',g.seller_id,
  'client_id',g.client_id,'label','connector')
 FROM public.commerce_connector_grants g
 JOIN public.commerce_oauth_clients c ON c.client_id=g.client_id AND c.revoked_at IS NULL
 WHERE g.access_hash=p_token_hash AND g.revoked_at IS NULL AND g.rotated_at IS NULL AND g.access_expires_at > now()
  AND (g.kind = 'buyer' OR EXISTS (SELECT 1 FROM public.commerce_sellers s WHERE s.id=g.seller_id AND s.owner_id=g.actor_id))
$$;

-- InsForge keeps accounts in auth.users, which the admin API role cannot read directly.
-- This narrow definer function returns one user ID for an exact (case-insensitive) email.
CREATE FUNCTION public.commerce_auth_user_by_email(p_email text)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE ids uuid[];
BEGIN
 IF p_email IS NULL OR length(trim(p_email)) NOT BETWEEN 3 AND 320 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT array_agg(u.id) INTO ids FROM auth.users u WHERE lower(u.email) = lower(trim(p_email));
 IF ids IS NULL THEN RAISE EXCEPTION 'user_not_found'; END IF;
 IF cardinality(ids) > 1 THEN RAISE EXCEPTION 'ambiguous_user'; END IF;
 RETURN ids[1];
END $$;

-- Demo setup: make a signed-up person the owner of one business (by exact name or ID).
CREATE FUNCTION public.commerce_assign_seller(p_email text, p_seller text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE uid uuid; actor uuid; s public.commerce_sellers; matches integer; previous uuid;
BEGIN
 uid := public.commerce_auth_user_by_email(p_email);
 actor := public.commerce_actor_for_user(uid,'Exchangent user');
 SELECT count(*) INTO matches FROM public.commerce_sellers
 WHERE lower(name) = lower(trim(p_seller)) OR id::text = lower(trim(p_seller));
 IF matches = 0 THEN RAISE EXCEPTION 'seller_not_found'; END IF;
 IF matches > 1 THEN RAISE EXCEPTION 'ambiguous_seller'; END IF;
 SELECT * INTO s FROM public.commerce_sellers
 WHERE lower(name) = lower(trim(p_seller)) OR id::text = lower(trim(p_seller)) FOR UPDATE;
 previous := s.owner_id;
 UPDATE public.commerce_sellers SET owner_id=actor WHERE id=s.id;
 RETURN jsonb_build_object('user_id',uid,'actor_id',actor,'seller_id',s.id,'seller_name',s.name,'enabled',s.enabled,
  'previous_owner_id',previous,'changed',previous IS DISTINCT FROM actor);
END $$;

DO $$ DECLARE t text; f record; BEGIN
 FOREACH t IN ARRAY ARRAY['commerce_oauth_clients','commerce_oauth_codes','commerce_connector_grants'] LOOP
   EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated',t);
 END LOOP;
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname IN ('commerce_oauth_upsert_client','commerce_oauth_targets','commerce_oauth_issue_code',
   'commerce_oauth_redeem_code','commerce_oauth_refresh','commerce_resolve_connector','commerce_auth_user_by_email',
   'commerce_assign_seller') LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.signature);
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO project_admin',f.signature);
 END LOOP;
END $$;
