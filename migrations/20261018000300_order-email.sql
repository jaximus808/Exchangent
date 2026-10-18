-- Order confirmation email (backend/src/order-email.ts). Additive only: no table changes.
-- The Stripe webhook's commerce_apply_payment already queues one 'order.confirmed' outbox row
-- per order (UNIQUE(kind,aggregate_id)); the email sender reads it here and marks it delivered
-- after Primitive accepts the send. delivered_at plus a per-order Primitive Idempotency-Key
-- means a retried webhook never sends a second email.

-- InsForge keeps accounts in auth.users, which the admin API role cannot read directly.
-- This narrow definer function returns, for one confirmed order only, the buyer's email
-- and whether its confirmation was already delivered. It returns no other user data.
CREATE FUNCTION public.commerce_order_email(p_order uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE ord public.commerce_orders; e public.commerce_outbox; addr text;
BEGIN
 SELECT * INTO ord FROM public.commerce_orders WHERE id=p_order;
 IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
 SELECT * INTO e FROM public.commerce_outbox WHERE kind='order.confirmed' AND aggregate_id=ord.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'event_not_found'; END IF;
 -- Demo actors have no auth user, so they have no address (email stays null).
 SELECT u.email INTO addr FROM public.commerce_actors a JOIN auth.users u ON u.id=a.auth_user_id
 WHERE a.id=ord.buyer_id;
 RETURN jsonb_build_object('order_id',ord.id,'reservation_id',ord.reservation_id,'buyer_id',ord.buyer_id,
  'email',nullif(trim(addr),''),'delivered',e.delivered_at IS NOT NULL);
END $$;

-- Same semantics as commerce_ack_event, for the one kind the worker feed excludes.
CREATE FUNCTION public.commerce_ack_order_email(p_order uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE e public.commerce_outbox;
BEGIN
 UPDATE public.commerce_outbox SET delivered_at=coalesce(delivered_at,now())
 WHERE kind='order.confirmed' AND aggregate_id=p_order RETURNING * INTO e;
 IF NOT FOUND THEN RAISE EXCEPTION 'event_not_found'; END IF;
 RETURN jsonb_build_object('order_id',e.aggregate_id,'kind',e.kind,'delivered_at',e.delivered_at);
END $$;

DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname IN ('commerce_order_email','commerce_ack_order_email') LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.signature);
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO project_admin',f.signature);
 END LOOP;
END $$;
