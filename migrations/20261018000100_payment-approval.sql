-- Optional human approval guard. Existing three-argument callers are unchanged.
-- A mismatch raises inside the same transaction as the hold, so stock and request
-- status both roll back. The displayed amount can never change silently.
CREATE FUNCTION public.commerce_reserve(p_buyer uuid,p_offer uuid,p_key text,p_expected_total integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE held jsonb;
BEGIN
 IF p_expected_total IS NULL OR p_expected_total<=0 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 held := public.commerce_reserve(p_buyer,p_offer,p_key);
 IF (held->>'total_cents')::integer<>p_expected_total THEN RAISE EXCEPTION 'price_changed'; END IF;
 RETURN held;
END $$;
REVOKE ALL ON FUNCTION public.commerce_reserve(uuid,uuid,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_reserve(uuid,uuid,text,integer) TO project_admin;
