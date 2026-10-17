/**
 * Single-worker serial queue (§6.5): decisions that read risk state and reserve run one at a time,
 * so no other decision can come between a limit check and its reservation.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
