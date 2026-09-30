-- 023_nri_gateway.sql
-- Phase 13 follow-up: real gateway payments for NRI packages.
--
--   nri_orders  gateway checkout stores the Razorpay order id and (after
--               /nri-orders/:id/verify) the gateway payment id. Status becomes
--               PENDING_PAYMENT at checkout in razorpay mode; mock mode still
--               settles PAID instantly exactly like before.
--
-- The ledger row (NRI_PAYMENT, amount = inr_equiv) is written at the money
-- moment: instantly in mock mode, or at signature verification in gateway mode.

ALTER TABLE nri_orders ADD COLUMN gateway_order_id TEXT DEFAULT '';
ALTER TABLE nri_orders ADD COLUMN gateway_payment_id TEXT DEFAULT '';
