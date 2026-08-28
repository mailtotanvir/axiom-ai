// k6 load profile for the RAG pipeline (milestone 5.3):
//   100 RPS concurrent document ingestion through services/rag-pipeline :8000.
//
// Usage:
//   k6 run -e BASE_URL=http://localhost:8000 -e TOKEN=<jwt> scripts/load/k6-rag-ingest.js

import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:8000";
const TOKEN = __ENV.TOKEN || "";
const COLLECTION = __ENV.COLLECTION || "load-test";

export const options = {
  scenarios: {
    ingest: {
      executor: "constant-arrival-rate",
      rate: 100,
      timeUnit: "1s",
      duration: "2m",
      preAllocatedVUs: 60,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<5000"],
    http_req_failed: ["rate<0.02"],
  },
};

// ~4 KB synthetic document body; variation forces distinct chunk hashes.
function documentBody(i) {
  const paragraph = `Load test document ${i} for tenant ingestion. `.repeat(4) +
    "The adaptive mesh refined its lattice, redistributing signal across every node. ".repeat(20);
  return JSON.stringify({
    collection: COLLECTION,
    documents: [
      {
        id: `loadtest-doc-${i}`,
        text: paragraph,
        metadata: { source: "k6-load-test", seq: i },
      },
    ],
  });
}

const params = {
  headers: {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  },
};

export default function () {
  const i = Math.floor(Math.random() * 1_000_000);
  const response = http.post(`${BASE_URL}/v1/documents/ingest`, documentBody(i), params);
  check(response, {
    "status 200 or 202": (r) => r.status === 200 || r.status === 202,
  });
}
