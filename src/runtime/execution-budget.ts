import { RuntimeError } from "./errors.js";
import { throwIfAborted } from "./retry.js";

/** Per-request limits. Configured Loop limits are ceilings for request overrides. */
export interface ExecutionBudget {
  /** Milliseconds from admission, including FIFO waiting and capability loading. */
  timeoutMs?: number;
  /** Total admitted tool calls, including automatic compression. Zero disables calls. */
  maxToolCalls?: number;
}

export class ExecutionBudgetExceededError extends RuntimeError {
  constructor(readonly budget: keyof ExecutionBudget, readonly limit: number) {
    super("EXECUTION_BUDGET_EXCEEDED", `Execution budget exceeded: ${budget}=${limit}`);
    this.name = "ExecutionBudgetExceededError";
  }
}

/** @internal */
export function validateExecutionBudget(budget: ExecutionBudget): void {
  if (budget.timeoutMs !== undefined && (!Number.isSafeInteger(budget.timeoutMs)
    || budget.timeoutMs < 1 || budget.timeoutMs > 2_147_483_647)) {
    throw new RangeError("timeoutMs must be an integer between 1 and 2147483647");
  }
  if (budget.maxToolCalls !== undefined && (!Number.isSafeInteger(budget.maxToolCalls)
    || budget.maxToolCalls < 0)) {
    throw new RangeError("maxToolCalls must be a non-negative safe integer");
  }
}

/** @internal One scope per admitted request; never race away from started work. */
export class ExecutionBudgetScope {
  readonly signal: AbortSignal | undefined;
  private readonly maxToolCalls?: number;
  private calls = 0;
  private readonly timer?: ReturnType<typeof setTimeout>;

  constructor(defaults: ExecutionBudget, requested: ExecutionBudget = {}, signal?: AbortSignal) {
    validateExecutionBudget(requested);
    this.maxToolCalls = smallerLimit(defaults.maxToolCalls, requested.maxToolCalls);
    const timeoutMs = smallerLimit(defaults.timeoutMs, requested.timeoutMs);
    if (timeoutMs === undefined) {
      this.signal = signal;
    } else {
      const deadline = new AbortController();
      this.signal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      this.timer = setTimeout(
        () => deadline.abort(new ExecutionBudgetExceededError("timeoutMs", timeoutMs)),
        timeoutMs,
      );
      this.timer.unref();
    }
  }

  reserveToolCalls(count: number): void {
    throwIfAborted(this.signal);
    if (this.maxToolCalls !== undefined && count > this.maxToolCalls - this.calls) {
      throw new ExecutionBudgetExceededError("maxToolCalls", this.maxToolCalls);
    }
    this.calls += count;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}

function smallerLimit(configured: number | undefined, requested: number | undefined) {
  if (configured === undefined) return requested;
  return requested === undefined ? configured : Math.min(configured, requested);
}
