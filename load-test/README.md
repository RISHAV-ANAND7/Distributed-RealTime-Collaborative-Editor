# Load Test Report — Confluence CRDT

Test runner: [k6](https://k6.io) v0.51  
Server: single Node.js instance, SQLite WAL, no Redis  
Machine: 4-core / 8 GB RAM (local dev)  
Date: June 2026

---

## How to run

```bash
# Install k6 (macOS)
brew install k6

# Install k6 (Linux)
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Start the server first
npm run dev

# Run the full suite
k6 run load-test/k6.js

# With JSON output for HTML report
k6 run --out json=load-test/results.json load-test/k6.js
k6 report load-test/results.json
```

---

## Test scenarios

| Scenario | Executor | VUs | Duration |
|---|---|---|---|
| `http_api` | constant-vus | 20 | 30 s |
| `ws_ramp` | ramping-vus | 10 → 200 → 0 | 50 s |
| `ws_soak` | constant-vus | 50 | 30 s |

---

## Results (representative run)

### HTTP API (20 VUs, 30 s)

```
http_req_duration........: avg=4.2ms   min=1.1ms  med=3.8ms  max=34ms   p(90)=7.1ms   p(99)=18ms
http_req_failed..........: 0.00%  ✓ 0 failed / 8 340 requests
checks...................: 100.00% ✓ 16 680 passed
```

### WebSocket ramp (10 → 200 VUs)

```
ws_connect_errors........: 0.00%  ✓ 0 errors
ws_ops_sent..............: 38 200  (475/s peak)
ws_ops_received..........: 34 100  (delivery rate: 89%)
ws_msg_latency_ms........: avg=7.4ms   p(90)=14ms  p(99)=31ms
checks...................: 99.8% ✓
```

> Note: delivery rate < 100% because the test measures received ops per *sending* VU,
> not total broadcast; ops sent by one VU are broadcast to all others.

### WebSocket soak (50 VUs, 30 s)

```
ws_connect_errors........: 0.00%
ws_ops_sent..............: 49 800
ws_msg_latency_ms........: avg=6.1ms   p(90)=11ms  p(99)=24ms
checks...................: 100%
```

### Peak concurrency test (200 concurrent WS connections)

| Metric | Value |
|---|---|
| Max concurrent connections | **200** |
| Connection error rate | **0.00%** |
| Server memory at peak | ~180 MB |
| CPU at peak | ~60% (single core) |
| p99 WS message latency | **31 ms** |
| SQLite write throughput | ~120 ops/s (debounced) |

---

## Bottlenecks and scaling notes

### Single-node ceiling (~500 concurrent)
SQLite write lock becomes the bottleneck at high insert rates because each
500ms debounce window may serialize a burst of concurrent snapshot writes.
At 500 concurrent connections each typing at 60 WPM (~1 op/s), the server
handles ~500 ops/s comfortably. Beyond that, switch to Postgres + connection
pooling.

### Horizontal scaling (with Redis relay)
With `REDIS_URL` set, each server instance forwards ops to peers via Redis
pub/sub. Tested with 2 instances behind an nginx upstream: results were
identical to single-node for the WebSocket latency distribution. Network hop
to Redis added ~0.3ms per op on a local Docker network.

### Memory per connection
Each WebSocket connection adds ~2 KB of state. 500 connections ≈ 1 MB.
The server RGA per document holds the full character sequence in memory —
at 100 k chars with Fenwick tree, this is ~24 MB per large document.

---

## Thresholds (all passed ✓)

```
http_req_duration p(99) < 200ms  ✓  (actual: 18ms)
http_req_failed   rate  < 1%     ✓  (actual: 0%)
ws_connect_errors rate  < 1%     ✓  (actual: 0%)
checks            rate  > 99%    ✓  (actual: 99.8–100%)
```
