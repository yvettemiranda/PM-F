-- A fully-filled FAK child order is not necessarily a fully-executed BUY:
-- the quoted order can be smaller than the approved capital reservation when
-- full-depth liquidity is insufficient. Persist the planner's immutable
-- completeness decision so Crash Recovery can reproduce the realtime state.
-- Existing rows remain NULL deliberately; guessing historical intent would be
-- less safe than freezing an unresolved legacy order during recovery.
ALTER TABLE live_orders
ADD COLUMN buy_budget_complete INTEGER
CHECK(buy_budget_complete IS NULL OR buy_budget_complete IN (0,1));

CREATE TRIGGER live_orders_buy_budget_complete_no_update
BEFORE UPDATE OF buy_budget_complete ON live_orders
WHEN NEW.buy_budget_complete IS NOT OLD.buy_budget_complete
BEGIN
  SELECT RAISE(ABORT, 'live_order buy_budget_complete is immutable');
END;
