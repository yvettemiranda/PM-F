export interface UnrealizedPnlInput {
  exitValueMicros: bigint;
  remainingCostMicros: bigint;
  estimatedExitFeeMicros: bigint;
}

export interface RealizedPnlInput {
  proceedsMicros: bigint;
  costBasisMicros: bigint;
  feeMicros: bigint;
}

export function calculateUnrealizedPnl(input: UnrealizedPnlInput): bigint {
  return input.exitValueMicros - input.estimatedExitFeeMicros - input.remainingCostMicros;
}

export function calculateRealizedPnl(input: RealizedPnlInput): bigint {
  return input.proceedsMicros - input.feeMicros - input.costBasisMicros;
}
