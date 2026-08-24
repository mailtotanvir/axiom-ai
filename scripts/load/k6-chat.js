// k6 load profile for the gateway (Phase 1 exit criteria):
//   500 concurrent SSE connections + sustained non-streaming traffic.
//
// Usage:
//   k6 run -e BASE_URL=http://localhost:3000 -e API_KEY=ax_... \
//          -e MODEL=gemini-3.6-flash scripts/load/k6-chat.js

import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const API_KEY = __ENV.API_KEY || "";
const MODEL = __ENV.MODEL || "gemini-3.6-flash";

export const options = {
  scenarios: {
    streaming: {
      executor: "constant-vus",
      vus: 500,
      duration: "2m",
      exec: "streamChat",
    },
    background: {
      executor: "constant-arrival-rate",
      rate: 100,
      timeUnit: "1s",
      duration: "2m",
      preAllocatedVUs: 50,
      exec: "plainChat",
    },
  },
};

function chatBody(stream) {
  return JSON.stringify({
    model: MODEL,
    messages: [{ role: "user", content: "Write a haiku about proxies." }],
    stream,
    max_tokens: 64,
  });
}

const params = {
  headers: {
    authorization: `Bearer ${API_KEY}`,
    "content-type": "application/json",
  },
};

export function streamChat() {
  const response = http.post(`${BASE_URL}/v1/chat/completions`, chatBody(true), params);
  check(response, {
    "status 200": (r) => r.status === 200,
    "is event-stream": (r) => r.headers["Content-Type"]?.includes("text/event-stream"),
  });
}

export function plainChat() {
  const response = http.post(`${BASE_URL}/v1/chat/completions`, chatBody(false), params);
  check(response, {
    "status 200": (r) => r.status === 200,
  });
}
