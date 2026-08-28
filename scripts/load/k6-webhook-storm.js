// k6 load profile for the agent runtime (milestone 5.3):
//   500 concurrent webhook delivery load storm through services/agent-runtime :5000.
//
// Usage:
//   k6 run -e BASE_URL=http://localhost:5000 -e TOKEN=<jwt> scripts/load/k6-webhook-storm.js
//
// The sink URL should point at a receiver that verifies
// `x-axiom-signature` (e.g. a tiny local HTTP server or httpbin.org/anything).

import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:5000";
const TOKEN = __ENV.TOKEN || "";

export const options = {
  scenarios: {
    webhook_storm: {
      executor: "constant-vus",
      vus: 500,
      duration: "2m",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{expected_response:true}": ["p(95)<1500"],
  },
};

const params = {
  headers: {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  },
};

export default function () {
  const runId = `loadtest-${__VU}-${__ITER}`;
  const body = JSON.stringify({
    runId,
    step: "notify",
    payload: {
      event: "loadtest.webhook",
      attempts: 1,
    },
  });
  const response = http.post(`${BASE_URL}/v1/webhooks/dispatch`, body, params);
  check(response, {
    "status 200 or 202": (r) => r.status === 200 || r.status === 202,
  });
}
