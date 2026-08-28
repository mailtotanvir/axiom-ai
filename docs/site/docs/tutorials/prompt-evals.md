# Tutorial: Prompt Evals

Goal: score a prompt version against a golden dataset and gate CI on
regressions.

1. Register a prompt in the ops-plane registry (semver, immutable once
   published):

```bash
curl http://localhost:4000/v1/prompts \
  -H "x-axiom-internal-secret: $AXIOM_INTER_SERVICE_SECRET" \
  -H "content-type: application/json" \
  -d '{"name": "summarizer", "version": "1.0.0", "template": "Summarize: {{text}}"}'
```

2. Create an eval with a golden dataset and run it; results land in
   ClickHouse with per-case scores.

3. Gate CI: the eval CLI compares against the previous passing run and exits
   non-zero on a score regression, so a bad prompt version cannot merge.

4. Ship safely: use the A/B experimentation engine (sticky hashing per
   tenant) to route a percentage of traffic to the candidate version before
   promoting it.
