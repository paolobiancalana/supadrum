/**
 * Every failure an agent can provoke through the broker carries a code, so a
 * caller can tell "you asked for something you may not have" from "the lease
 * is not ready yet, ask again" from "the broker broke". Without it the MCP
 * surface flattens all of them into one opaque error string and an agent's
 * only recourse is to guess whether retrying is sensible.
 */
export const brokerErrorCodes = [
  "unknown_project",
  "unknown_job",
  "unknown_session",
  "capability_denied",
  "approval_not_required",
  "invalid_input",
  "idempotency_conflict",
  "job_state_conflict",
  "session_state_conflict",
  "session_not_active",
  "internal_invariant"
] as const;

export type BrokerErrorCode = (typeof brokerErrorCodes)[number];

/**
 * Whether repeating the identical request could succeed later without the
 * caller changing anything. Kept as one table rather than an argument at each
 * throw site: the answer belongs to the code, and duplicating it per site is
 * how two throws of the same kind end up disagreeing.
 */
const retryableByCode: Readonly<Record<BrokerErrorCode, boolean>> = {
  unknown_project: false,
  unknown_job: false,
  unknown_session: false,
  capability_denied: false,
  approval_not_required: false,
  invalid_input: false,
  idempotency_conflict: false,
  job_state_conflict: false,
  session_state_conflict: false,
  // The lease exists but its open job has not been granted yet; the same
  // call succeeds once the runner activates it.
  session_not_active: true,
  internal_invariant: false
};

export class BrokerError extends Error {
  readonly code: BrokerErrorCode;
  readonly retryable: boolean;

  constructor(code: BrokerErrorCode, message: string) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
    this.retryable = retryableByCode[code];
  }
}
