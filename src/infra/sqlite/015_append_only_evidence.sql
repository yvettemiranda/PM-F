-- Production evidence and financial ledgers are append-only.

CREATE TRIGGER signals_no_update
BEFORE UPDATE ON signals
BEGIN
  SELECT RAISE(ABORT, 'signals is immutable');
END;

CREATE TRIGGER signals_no_delete
BEFORE DELETE ON signals
BEGIN
  SELECT RAISE(ABORT, 'signals is immutable');
END;

CREATE TRIGGER state_transitions_no_update
BEFORE UPDATE ON state_transitions
BEGIN
  SELECT RAISE(ABORT, 'state_transitions is immutable');
END;

CREATE TRIGGER state_transitions_no_delete
BEFORE DELETE ON state_transitions
BEGIN
  SELECT RAISE(ABORT, 'state_transitions is immutable');
END;

CREATE TRIGGER api_captures_no_update
BEFORE UPDATE ON api_captures
BEGIN
  SELECT RAISE(ABORT, 'api_captures is immutable');
END;

CREATE TRIGGER api_captures_no_delete
BEFORE DELETE ON api_captures
BEGIN
  SELECT RAISE(ABORT, 'api_captures is immutable');
END;

CREATE TRIGGER api_capture_payloads_no_update
BEFORE UPDATE ON api_capture_payloads
BEGIN
  SELECT RAISE(ABORT, 'api_capture_payloads is immutable');
END;

CREATE TRIGGER api_capture_payloads_no_delete
BEFORE DELETE ON api_capture_payloads
BEGIN
  SELECT RAISE(ABORT, 'api_capture_payloads is immutable');
END;

CREATE TRIGGER capture_manifest_items_no_update
BEFORE UPDATE ON capture_manifest_items
BEGIN
  SELECT RAISE(ABORT, 'capture_manifest_items is immutable');
END;

CREATE TRIGGER capture_manifest_items_no_delete
BEFORE DELETE ON capture_manifest_items
BEGIN
  SELECT RAISE(ABORT, 'capture_manifest_items is immutable');
END;

CREATE TRIGGER replay_event_classifications_no_update
BEFORE UPDATE ON replay_event_classifications
BEGIN
  SELECT RAISE(ABORT, 'replay_event_classifications is immutable');
END;

CREATE TRIGGER replay_event_classifications_no_delete
BEFORE DELETE ON replay_event_classifications
BEGIN
  SELECT RAISE(ABORT, 'replay_event_classifications is immutable');
END;

CREATE TRIGGER golden_expectations_no_update
BEFORE UPDATE ON golden_expectations
BEGIN
  SELECT RAISE(ABORT, 'golden_expectations is immutable');
END;

CREATE TRIGGER golden_expectations_no_delete
BEFORE DELETE ON golden_expectations
BEGIN
  SELECT RAISE(ABORT, 'golden_expectations is immutable');
END;

CREATE TRIGGER golden_results_no_update
BEFORE UPDATE ON golden_results
BEGIN
  SELECT RAISE(ABORT, 'golden_results is immutable');
END;

CREATE TRIGGER golden_results_no_delete
BEFORE DELETE ON golden_results
BEGIN
  SELECT RAISE(ABORT, 'golden_results is immutable');
END;

CREATE TRIGGER paper_cash_ledger_no_update
BEFORE UPDATE ON paper_cash_ledger
BEGIN
  SELECT RAISE(ABORT, 'paper_cash_ledger is immutable');
END;

CREATE TRIGGER paper_cash_ledger_no_delete
BEFORE DELETE ON paper_cash_ledger
BEGIN
  SELECT RAISE(ABORT, 'paper_cash_ledger is immutable');
END;

CREATE TRIGGER paper_reservation_ledger_no_update
BEFORE UPDATE ON paper_reservation_ledger
BEGIN
  SELECT RAISE(ABORT, 'paper_reservation_ledger is immutable');
END;

CREATE TRIGGER paper_reservation_ledger_no_delete
BEFORE DELETE ON paper_reservation_ledger
BEGIN
  SELECT RAISE(ABORT, 'paper_reservation_ledger is immutable');
END;

CREATE TRIGGER paper_fill_ledger_no_update
BEFORE UPDATE ON paper_fill_ledger
BEGIN
  SELECT RAISE(ABORT, 'paper_fill_ledger is immutable');
END;

CREATE TRIGGER paper_fill_ledger_no_delete
BEFORE DELETE ON paper_fill_ledger
BEGIN
  SELECT RAISE(ABORT, 'paper_fill_ledger is immutable');
END;

CREATE TRIGGER paper_fee_ledger_no_update
BEFORE UPDATE ON paper_fee_ledger
BEGIN
  SELECT RAISE(ABORT, 'paper_fee_ledger is immutable');
END;

CREATE TRIGGER paper_fee_ledger_no_delete
BEFORE DELETE ON paper_fee_ledger
BEGIN
  SELECT RAISE(ABORT, 'paper_fee_ledger is immutable');
END;

CREATE TRIGGER paper_pnl_ledger_no_update
BEFORE UPDATE ON paper_pnl_ledger
BEGIN
  SELECT RAISE(ABORT, 'paper_pnl_ledger is immutable');
END;

CREATE TRIGGER paper_pnl_ledger_no_delete
BEFORE DELETE ON paper_pnl_ledger
BEGIN
  SELECT RAISE(ABORT, 'paper_pnl_ledger is immutable');
END;

CREATE TRIGGER paper_state_transitions_no_update
BEFORE UPDATE ON paper_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'paper_state_transitions is immutable');
END;

CREATE TRIGGER paper_state_transitions_no_delete
BEFORE DELETE ON paper_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'paper_state_transitions is immutable');
END;

CREATE TRIGGER live_fills_no_update
BEFORE UPDATE ON live_fills
BEGIN
  SELECT RAISE(ABORT, 'live_fills is immutable');
END;

CREATE TRIGGER live_fills_no_delete
BEFORE DELETE ON live_fills
BEGIN
  SELECT RAISE(ABORT, 'live_fills is immutable');
END;

CREATE TRIGGER live_cash_ledger_no_update
BEFORE UPDATE ON live_cash_ledger
BEGIN
  SELECT RAISE(ABORT, 'live_cash_ledger is immutable');
END;

CREATE TRIGGER live_cash_ledger_no_delete
BEFORE DELETE ON live_cash_ledger
BEGIN
  SELECT RAISE(ABORT, 'live_cash_ledger is immutable');
END;

CREATE TRIGGER live_reservation_ledger_no_update
BEFORE UPDATE ON live_reservation_ledger
BEGIN
  SELECT RAISE(ABORT, 'live_reservation_ledger is immutable');
END;

CREATE TRIGGER live_reservation_ledger_no_delete
BEFORE DELETE ON live_reservation_ledger
BEGIN
  SELECT RAISE(ABORT, 'live_reservation_ledger is immutable');
END;

CREATE TRIGGER live_fill_ledger_no_update
BEFORE UPDATE ON live_fill_ledger
BEGIN
  SELECT RAISE(ABORT, 'live_fill_ledger is immutable');
END;

CREATE TRIGGER live_fill_ledger_no_delete
BEFORE DELETE ON live_fill_ledger
BEGIN
  SELECT RAISE(ABORT, 'live_fill_ledger is immutable');
END;

CREATE TRIGGER live_fee_ledger_no_update
BEFORE UPDATE ON live_fee_ledger
BEGIN
  SELECT RAISE(ABORT, 'live_fee_ledger is immutable');
END;

CREATE TRIGGER live_fee_ledger_no_delete
BEFORE DELETE ON live_fee_ledger
BEGIN
  SELECT RAISE(ABORT, 'live_fee_ledger is immutable');
END;

CREATE TRIGGER live_pnl_ledger_no_update
BEFORE UPDATE ON live_pnl_ledger
BEGIN
  SELECT RAISE(ABORT, 'live_pnl_ledger is immutable');
END;

CREATE TRIGGER live_pnl_ledger_no_delete
BEFORE DELETE ON live_pnl_ledger
BEGIN
  SELECT RAISE(ABORT, 'live_pnl_ledger is immutable');
END;

CREATE TRIGGER live_state_transitions_no_update
BEFORE UPDATE ON live_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'live_state_transitions is immutable');
END;

CREATE TRIGGER live_state_transitions_no_delete
BEFORE DELETE ON live_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'live_state_transitions is immutable');
END;

CREATE TRIGGER capture_runs_no_update
BEFORE UPDATE ON capture_runs
BEGIN
  SELECT RAISE(ABORT, 'capture_runs is immutable');
END;

CREATE TRIGGER capture_runs_no_delete
BEFORE DELETE ON capture_runs
BEGIN
  SELECT RAISE(ABORT, 'capture_runs is immutable');
END;

CREATE TRIGGER position_baseline_runs_no_update
BEFORE UPDATE ON position_baseline_runs
BEGIN
  SELECT RAISE(ABORT, 'position_baseline_runs is immutable');
END;

CREATE TRIGGER position_baseline_runs_no_delete
BEFORE DELETE ON position_baseline_runs
BEGIN
  SELECT RAISE(ABORT, 'position_baseline_runs is immutable');
END;

CREATE TRIGGER position_baseline_items_no_update
BEFORE UPDATE ON position_baseline_items
BEGIN
  SELECT RAISE(ABORT, 'position_baseline_items is immutable');
END;

CREATE TRIGGER position_baseline_items_no_delete
BEFORE DELETE ON position_baseline_items
BEGIN
  SELECT RAISE(ABORT, 'position_baseline_items is immutable');
END;

CREATE TRIGGER capital_estimates_no_update
BEFORE UPDATE ON capital_estimates
BEGIN
  SELECT RAISE(ABORT, 'capital_estimates is immutable');
END;

CREATE TRIGGER capital_estimates_no_delete
BEFORE DELETE ON capital_estimates
BEGIN
  SELECT RAISE(ABORT, 'capital_estimates is immutable');
END;

CREATE TRIGGER replay_runs_no_update
BEFORE UPDATE ON replay_runs
BEGIN
  SELECT RAISE(ABORT, 'replay_runs is immutable');
END;

CREATE TRIGGER replay_runs_no_delete
BEFORE DELETE ON replay_runs
BEGIN
  SELECT RAISE(ABORT, 'replay_runs is immutable');
END;

CREATE TRIGGER position_bucket_ledger_no_update
BEFORE UPDATE ON position_bucket_ledger
BEGIN
  SELECT RAISE(ABORT, 'position_bucket_ledger is immutable');
END;
CREATE TRIGGER position_bucket_ledger_no_delete
BEFORE DELETE ON position_bucket_ledger
BEGIN
  SELECT RAISE(ABORT, 'position_bucket_ledger is immutable');
END;
