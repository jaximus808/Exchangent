-- Release holds that can never be paid. commerce_begin_checkout refuses a hold with less
-- than 33 minutes left, and only holds with an open Stripe Checkout get released by the
-- checkout.session.expired webhook. A hold that never opened checkout used to keep its
-- stock and leave the request in 'awaiting_payment' forever, blocking a new reservation.
-- The backend calls this before every reservation. Same release steps as commerce_apply_payment.
CREATE FUNCTION public.commerce_release_stale_holds()
RETURNS integer LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.commerce_reservations; n integer := 0;
BEGIN
 FOR r IN SELECT * FROM public.commerce_reservations
   WHERE status='held' AND checkout_expires_at IS NULL AND expires_at < now()+interval '33 minutes'
   ORDER BY id FOR UPDATE SKIP LOCKED LOOP
   UPDATE public.commerce_inventory i SET available=i.available+ri.quantity FROM public.commerce_reservation_items ri
     WHERE ri.reservation_id=r.id AND ri.inventory_id=i.id;
   UPDATE public.commerce_reservations SET status='expired' WHERE id=r.id;
   UPDATE public.commerce_requests SET status='negotiating' WHERE id=r.request_id AND status='awaiting_payment';
   n := n+1;
 END LOOP;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.commerce_release_stale_holds() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_release_stale_holds() TO project_admin;
