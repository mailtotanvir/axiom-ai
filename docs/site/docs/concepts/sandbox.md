# Sandbox Isolation

Agent steps run tenant-supplied code inside `isolated-vm`: a V8 isolate with
no host bindings, no filesystem, and no network.

Hard limits enforced by the executor:

| Limit | Behavior on breach |
|---|---|
| CPU time | Step terminated, counted on `agent_runtime_sandbox_rejections_total{reason="timeout"}` |
| Memory | Isolate killed, `reason="memory"` |
| Runtime error | Clean failure recorded on the run log, `reason="runtime"` |
| Security violation | Immediate rejection, `reason="security"` |

A red-team escape suite runs in CI asserting that `process`, `fs`, network
access, and prototype-pollution escape paths are unavailable to guest code.

Webhook delivery out of the runtime is HMAC-SHA256 signed
(`x-axiom-signature`) with jittered exponential backoff and a dead-letter
queue for exhausted retries.
