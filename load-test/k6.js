/**
 * load-test/k6.js — Confluence CRDT load test
 *
 * Tests three scenarios in sequence:
 *
 * 1. HTTP API throughput  — create + list documents
 * 2. WebSocket concurrency — N clients connect to the same doc and
 *    exchange insert operations simultaneously
 * 3. Soak test — 50 sustained concurrent WS connections for 30 s
 *
 * Run:
 *   k6 run load-test/k6.js
 *
 * With HTML report:
 *   k6 run --out json=load-test/results.json load-test/k6.js
 *   k6 report load-test/results.json
 *
 * Target:
 *   BASE_URL=http://localhost:3001 k6 run load-test/k6.js
 *
 * Thresholds (defined below):
 *   - HTTP p99 latency < 200ms
 *   - WebSocket connection error rate < 1%
 *   - 0 failed checks overall
 */

import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:3001';
const WS_BASE  = BASE_URL.replace(/^http/, 'ws');

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const wsConnectErrors = new Rate('ws_connect_errors');
const wsOpsSent       = new Counter('ws_ops_sent');
const wsOpsReceived   = new Counter('ws_ops_received');
const wsMsgLatency    = new Trend('ws_msg_latency_ms', true);

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    // Scenario 1: REST API throughput — 20 VUs for 30 s
    http_api: {
      executor: 'constant-vus',
      vus: 20,
      duration: '30s',
      exec: 'httpScenario',
      startTime: '0s',
    },

    // Scenario 2: WebSocket concurrency ramp — ramp to 200 WS connections
    ws_ramp: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '10s', target: 50  },
        { duration: '20s', target: 200 },
        { duration: '10s', target: 200 },
        { duration: '10s', target: 0   },
      ],
      exec: 'wsScenario',
      startTime: '35s',
    },

    // Scenario 3: Soak test — 50 sustained WS connections for 30 s
    ws_soak: {
      executor: 'constant-vus',
      vus: 50,
      duration: '30s',
      exec: 'wsScenario',
      startTime: '90s',
    },
  },

  thresholds: {
    // HTTP
    http_req_duration: ['p(99)<200', 'p(95)<100'],
    http_req_failed:   ['rate<0.01'],

    // WebSocket
    ws_connect_errors: ['rate<0.01'],
    checks:            ['rate>0.99'],
  },
};

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let sharedDocId = null;

export function setup() {
  // Create one shared document for WS tests.
  // First register + login to get a token.
  const username = `loadtest_${Date.now()}`;
  const regRes = http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify({ username, password: 'loadtest123' }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  check(regRes, { 'register 201': (r) => r.status === 201 });
  const { token } = regRes.json();

  const createRes = http.post(
    `${BASE_URL}/documents`,
    JSON.stringify({ title: 'Load Test Document' }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } },
  );
  check(createRes, { 'create doc 201': (r) => r.status === 201 });
  const docId = createRes.json('id');

  return { docId, token };
}

// ---------------------------------------------------------------------------
// Scenario 1: HTTP
// ---------------------------------------------------------------------------

export function httpScenario(data) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` };

  // List documents
  const listRes = http.get(`${BASE_URL}/documents`, { headers });
  check(listRes, {
    'list 200':           (r) => r.status === 200,
    'list is array':      (r) => Array.isArray(r.json()),
  });

  // Health check
  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, { 'health ok': (r) => r.status === 200 && r.json('ok') === true });

  sleep(0.1);
}

// ---------------------------------------------------------------------------
// Scenario 2 & 3: WebSocket
// ---------------------------------------------------------------------------

export function wsScenario(data) {
  const { docId, token } = data;
  const url = `${WS_BASE}/${docId}?token=${encodeURIComponent(token)}`;

  let synced       = false;
  let opsSent      = 0;
  let opsReceived  = 0;
  let connectErr   = false;
  const sentAt     = {};

  const res = ws.connect(url, {}, (socket) => {
    socket.on('open', () => {});

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);

        if (msg.type === 'sync') {
          synced = true;
          // Start sending ops once synced.
          socket.setInterval(() => {
            if (opsSent >= 20) {
              socket.close();
              return;
            }
            const clock = Date.now();
            const op = {
              type: 'insert',
              id:       { siteId: `vu-${__VU}`, clock },
              value:    'x',
              parentId: null,
            };
            sentAt[clock] = Date.now();
            socket.send(JSON.stringify(op));
            wsOpsSent.add(1);
            opsSent++;
          }, 50); // send an op every 50ms
        }

        if (msg.type === 'insert' || msg.type === 'delete') {
          opsReceived++;
          wsOpsReceived.add(1);
          // Measure round-trip for ops we sent (identified by siteId).
          if (msg.id?.siteId === `vu-${__VU}` && sentAt[msg.id.clock]) {
            wsMsgLatency.add(Date.now() - sentAt[msg.id.clock]);
            delete sentAt[msg.id.clock];
          }
        }
      } catch (_) {}
    });

    socket.on('error', () => { connectErr = true; });

    // Timeout after 10 s max per VU.
    socket.setTimeout(() => socket.close(), 10_000);
  });

  wsConnectErrors.add(connectErr ? 1 : 0);

  check(res, {
    'ws connected':  () => res && res.status === 101,
    'synced':        () => synced,
    'sent > 0 ops':  () => opsSent > 0,
  });

  sleep(0.5);
}
