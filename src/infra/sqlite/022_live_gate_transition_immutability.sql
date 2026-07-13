-- Live Gate transitions define activation boundaries consumed by Live runners.
-- They are immutable evidence once recorded.
CREATE TRIGGER live_gate_state_transitions_no_update
BEFORE UPDATE ON live_gate_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'live_gate_state_transitions is immutable');
END;

CREATE TRIGGER live_gate_state_transitions_no_delete
BEFORE DELETE ON live_gate_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'live_gate_state_transitions is immutable');
END;
