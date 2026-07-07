type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

export function transition<S extends string>(map: TransitionMap<S>, current: S, next: S): S {
  if (!map[current].includes(next)) throw new Error(`Illegal transition: ${current} -> ${next}`);
  return next;
}

export type MonitorState =
  | "UNCONFIGURED"
  | "IDENTIFYING"
  | "BASELINING"
  | "ONLINE"
  | "DISCONNECTED"
  | "GAP_IMPORTING"
  | "RECONCILING"
  | "MINOR_DIFF"
  | "MAJOR_DESYNC";

export const MONITOR_TRANSITIONS: TransitionMap<MonitorState> = {
  UNCONFIGURED: ["IDENTIFYING"],
  IDENTIFYING: ["BASELINING", "MAJOR_DESYNC"],
  BASELINING: ["ONLINE", "MAJOR_DESYNC"],
  ONLINE: ["DISCONNECTED", "RECONCILING", "MINOR_DIFF", "MAJOR_DESYNC"],
  DISCONNECTED: ["GAP_IMPORTING", "MAJOR_DESYNC"],
  GAP_IMPORTING: ["RECONCILING", "MAJOR_DESYNC"],
  RECONCILING: ["ONLINE", "MINOR_DIFF", "MAJOR_DESYNC"],
  MINOR_DIFF: ["ONLINE", "RECONCILING", "MAJOR_DESYNC"],
  MAJOR_DESYNC: ["RECONCILING"],
};

export type ReplayState = "CREATED" | "INPUT_VALIDATING" | "RUNNING" | "COMPARING" | "PASSED" | "FAILED" | "INCOMPLETE";

export const REPLAY_TRANSITIONS: TransitionMap<ReplayState> = {
  CREATED: ["INPUT_VALIDATING"],
  INPUT_VALIDATING: ["RUNNING", "FAILED", "INCOMPLETE"],
  RUNNING: ["COMPARING", "FAILED", "INCOMPLETE"],
  COMPARING: ["PASSED", "FAILED", "INCOMPLETE"],
  PASSED: [],
  FAILED: [],
  INCOMPLETE: [],
};

export type SignalState = "CREATED" | "VALIDATING" | "READY" | "PUBLISHED" | "REJECTED" | "CANCELLED";

export const SIGNAL_TRANSITIONS: TransitionMap<SignalState> = {
  CREATED: ["VALIDATING", "CANCELLED"],
  VALIDATING: ["READY", "REJECTED", "CANCELLED"],
  READY: ["PUBLISHED", "REJECTED", "CANCELLED"],
  PUBLISHED: [],
  REJECTED: [],
  CANCELLED: [],
};
