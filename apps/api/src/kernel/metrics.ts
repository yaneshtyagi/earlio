/** Prometheus text exposition for request counts and latency, without a client library. */
const BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
export class Metrics {
  private counts = new Map<string, number>();
  private hist = new Map<string, { buckets: number[]; sum: number; count: number }>();
  observe(method: string, route: string, status: number, seconds: number) {
    const ck = `${method}|${route}|${status}`; this.counts.set(ck, (this.counts.get(ck) ?? 0) + 1);
    const hk = `${method}|${route}`; const h = this.hist.get(hk) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((b, i) => { if (seconds <= b) h.buckets[i]!++; }); h.sum += seconds; h.count++; this.hist.set(hk, h);
  }
  render(gauges: Record<string, number> = {}): string {
    const out: string[] = ['# TYPE earlio_http_requests_total counter'];
    for (const [k, v] of this.counts) { const [m, r, s] = k.split('|'); out.push(`earlio_http_requests_total{method="${m}",route="${r}",status="${s}"} ${v}`); }
    out.push('# TYPE earlio_http_request_duration_seconds histogram');
    for (const [k, h] of this.hist) {
      const [m, r] = k.split('|'); const l = `method="${m}",route="${r}"`;
      BUCKETS.forEach((b, i) => out.push(`earlio_http_request_duration_seconds_bucket{${l},le="${b}"} ${h.buckets[i]}`));
      out.push(`earlio_http_request_duration_seconds_bucket{${l},le="+Inf"} ${h.count}`, `earlio_http_request_duration_seconds_sum{${l}} ${h.sum.toFixed(6)}`, `earlio_http_request_duration_seconds_count{${l}} ${h.count}`);
    }
    for (const [k, v] of Object.entries(gauges)) out.push(`# TYPE ${k} gauge`, `${k} ${v}`);
    return out.join('\n') + '\n';
  }
}
