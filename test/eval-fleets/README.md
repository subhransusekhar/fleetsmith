# Eval fleets

Held-out fleet specs used by `fleetsmith eval` as a regression suite. Each file
is a normal `fleet.yaml` plus a top-level `expect:` block declaring what must
hold after it compiles.

They deliberately cover patterns and shapes the meta-fleet itself does not use
(fanout, generate-verify with loops, supervisor with a name collision, a
minimal single-agent fleet), because a change that suits one fleet shape while
breaking another is exactly what a self-modifying compiler is prone to.

> **This directory is on the protected path list.** The evolution loop may
> propose *adding* cases; it may never edit or remove existing ones. Given a
> scored detector, an optimizer deletes the detector — that is not a
> hypothetical, it is the documented Darwin Gödel Machine result.

`expect:` keys: `agents`, `skills`, `pattern`, `emits[]` (compiled paths that
must exist).
