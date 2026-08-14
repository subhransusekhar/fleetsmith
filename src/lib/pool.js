/**
 * Bounded-concurrency map, order-preserving.
 *
 * Every model-backed measurement in this codebase is a fan-out of independent
 * calls — one per skill, one per case — and each one is a full headless agent
 * session costing seconds to minutes. Running them one at a time makes the
 * wall-clock the sum rather than the max, which is the difference between a
 * suite someone runs and a suite someone stops running.
 *
 * Two properties are load-bearing:
 *  - **Results keep input order.** A judge or exec report whose rows shuffle
 *    between runs cannot be diffed against a baseline, and paired comparison is
 *    the only way either suite produces a usable number.
 *  - **A rejection does not sink its siblings.** These are advisory suites; one
 *    unreachable runner must degrade that row, not lose the other N-1 results
 *    that already cost real money. Rejections are returned as `{ error }` for
 *    the caller to fold into its own per-item shape.
 */
export async function mapPool(items, limit, fn) {
  const list = [...items];
  const out = new Array(list.length);
  const width = Math.max(1, Math.min(Number(limit) || 1, list.length));
  let next = 0;

  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      try {
        out[i] = { value: await fn(list[i], i) };
      } catch (error) {
        out[i] = { error };
      }
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return out;
}
