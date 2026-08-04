# Running the evolution loop on a cadence

`fleetsmith evolve` is designed to be run periodically, not continuously. This
document is the operational half of `docs/milestones/v0.5.0-self-evolution.md`.

## The rule that matters most

**Never schedule `--apply` outside the auto-apply whitelist.**

An unattended loop that can merge arbitrary changes is a loop that will
eventually merge a bad one at 3am with nobody reading the diff. `--apply` merges
*only* proposals whose every op is on the whitelist (`update-bullet-counter`,
`add-validator`) — ops whose correctness a validator fully decides. Everything
else queues for `--review`, and queuing is the point.

The failure mode this guards against is not the model proposing something
dangerous; the deterministic gates catch that. It is **automation bias**: a
reviewer handed a steady stream of mostly-fine changes stops reading them. Keep
the queue short and the review real.

## Suggested cadence

Weekly is a reasonable default. The loop exits immediately when health has not
moved (ΔH early exit), so a scheduled run on a quiet week costs nothing.

**Claude Code** — add to `.claude/loop.md`, then run `/loop`:

```
fleetsmith health fleet.yaml
fleetsmith evolve fleet.yaml --budget 1
```

**goose** — a recipe on a cron schedule:

```bash
goose schedule add --name fleet-evolve --cron "0 0 9 * * 1" \
  --recipe .goose/recipes/evolve.yaml
```

**Plain cron / CI** — propose only, and let the proposals wait:

```
0 9 * * 1  cd /path/to/repo && fleetsmith evolve fleet.yaml --budget 1
```

## Reviewing

```bash
fleetsmith evolve fleet.yaml --review                     # next proposal + diffstat
fleetsmith evolve fleet.yaml --accept fleet-evolve/<id>   # merge + tag fleet-gen/N
fleetsmith evolve fleet.yaml --reject fleet-evolve/<id> --reason "..."
```

Proposals are presented **one at a time**, ranked by measured eval delta times
stated confidence. Rejections are recorded, and op categories you keep declining
are pushed down the ranking and reported to the proposer so it stops suggesting
them. That is the only mechanism here that reduces review volume over time
rather than merely capping it — so **always give a reason**; it is what the
system learns from.

## After a merge: the canary

A merged generation is **provisional**, not confirmed. `fleetsmith health`
reports its state:

- `provisional` — fewer than 3 runs since the merge; not enough evidence yet.
- `confirmed` — runs completed with no health regression.
- `regressed` — harness health worsened. This is the case CI cannot catch: a
  change that passes every deterministic check and still makes real runs worse.

Rollback is `git revert`:

```bash
git revert fleet-gen/<n>
fleetsmith build fleet.yaml --target all --force
fleetsmith qa fleet.yaml --built .
```

This path is covered by a test, because a rollback nobody has run is a rollback
that does not work.

## What to watch for

- **Proposals that are mostly noise.** If most get rejected, the dossier is not
  carrying enough signal — check that `qa` and `eval` are actually failing on
  something before blaming the proposer.
- **A steadily growing accept rate with no health improvement.** That is the
  shape of reward hacking: changes that satisfy the metric without improving the
  harness. Re-read `_fleet/shared/evolution/decisions.jsonl` against
  `health.json` before trusting the trend.
- **Anything touching a protected path.** CI fails the branch; do not "fix" it
  by editing the protected list.
