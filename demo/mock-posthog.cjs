/**
 * Mock PostHog query API — for testing atlas-report's LIVE query path without a
 * personal API key.
 *
 * It stands in for `POST {host}/api/projects/{id}/query/` and replays the ACTUAL
 * rows we queried out of PostHog project App (111361) for the seeded demo apps.
 * The generator can't tell it apart from real PostHog: same URL shape, same
 * `{ results: [...] }` envelope, same row order the three HogQL queries produce.
 *
 *   node demo/mock-posthog.cjs 8799 &
 *   POSTHOG_PERSONAL_API_KEY=test node packages/report/dist/cli.js generate \
 *     --app <app-id> --project 111361 --host http://localhost:8799 \
 *     --screen-map demo/<app>-screen-map.json --out /tmp/live.html
 *
 * Data below is the real count(DISTINCT person_id) output (last 24h) at the time
 * of seeding — the same numbers the MCP `execute-sql` calls returned.
 */

const http = require("node:http");

// app_id -> { screens:[[screen,users,events]], transitions:[[src,dst,users]], leavers:[[src,leavers]] }
const DATA = {
  // Vault — KYC onboarding
  "449ae04e-24b3-45a6-b125-c628092c441e": {
    screens: [
      ["/onboarding/welcome", 1892, 1892],
      ["/onboarding/email", 1637, 1637],
      ["/onboarding/phone", 1416, 1416],
      ["/onboarding/verify", 1074, 1074],
      ["/onboarding/address", 909, 909],
      ["/onboarding/id", 581, 581],
      ["/onboarding/face-scan", 316, 316],
      ["/onboarding/approved", 254, 254],
      ["/home", 250, 250],
    ],
    transitions: [
      ["/onboarding/welcome", "/onboarding/email", 1655],
      ["/onboarding/email", "/onboarding/phone", 1434],
      ["/onboarding/phone", "/onboarding/verify", 1096],
      ["/onboarding/verify", "/onboarding/address", 929],
      ["/onboarding/address", "/onboarding/id", 593],
      ["/onboarding/id", "/onboarding/face-scan", 335],
      ["/onboarding/face-scan", "/onboarding/approved", 280],
      ["/onboarding/approved", "/home", 270],
    ],
    leavers: [
      ["/onboarding/welcome", 1670],
      ["/onboarding/email", 1453],
      ["/onboarding/phone", 1113],
      ["/onboarding/verify", 943],
      ["/onboarding/address", 607],
      ["/onboarding/id", 347],
      ["/onboarding/face-scan", 295],
      ["/onboarding/approved", 280],
    ],
  },
  // Crate — checkout
  "cda16afc-2b9c-4042-a0c2-d863dc3c9ec6": {
    screens: [
      ["/", 1201, 1201],
      ["/collection", 790, 790],
      ["/product/[id]", 570, 570],
      ["/checkout", 240, 240],
      ["/order/confirmed", 140, 140],
      ["/bag", 130, 130],
      ["/account", 70, 70],
    ],
    transitions: [
      ["/", "/collection", 789],
      ["/collection", "/product/[id]", 569],
      ["/product/[id]", "/checkout", 240],
      ["/checkout", "/order/confirmed", 140],
      ["/", "/bag", 130],
      ["/product/[id]", "/account", 69],
    ],
    leavers: [
      ["/", 920],
      ["/collection", 570],
      ["/product/[id]", 310],
      ["/checkout", 140],
    ],
  },
};

function classify(sql) {
  if (/windowFunnel/i.test(sql)) return "funnel";
  if (/AS leavers/i.test(sql)) return "leavers";
  if (/AS dst/i.test(sql)) return "transitions";
  return "screens";
}

// The sequential funnel query returns one row: distinct persons reaching each
// ordered step (monotone). The step key-sets come in as values.step0..stepN.
// For the demo's clean linear seeds this is the per-screen count in path order.
function funnelResult(data, values) {
  const usersByKey = {};
  if (data) for (const [key, users] of data.screens) usersByKey[key] = users;
  const steps = [];
  for (let i = 0; values && values[`step${i}`] !== undefined; i++) steps.push(values[`step${i}`]);
  let running = Infinity;
  return steps.map((keys) => {
    const stepUsers = Math.max(0, ...keys.map((k) => usersByKey[k] || 0));
    running = Math.min(running, stepUsers);
    return running;
  });
}

const port = Number(process.argv[2] || 8799);

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // URL shape check — must be /api/projects/<id>/query/
      const okUrl = /^\/api\/projects\/[^/]+\/query\/?$/.test(req.url || "");
      const auth = req.headers["authorization"] || "";
      if (!okUrl || req.method !== "POST") {
        res.writeHead(404).end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (!/^Bearer\s+.+/.test(auth)) {
        // Prove the generator actually sends the personal API key.
        res.writeHead(401).end(JSON.stringify({ error: "missing bearer token" }));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: "bad json" }));
        return;
      }
      const sql = parsed?.query?.query || "";
      const values = parsed?.query?.values || {};
      const appId = values.app_id;
      const kind = classify(sql);
      const data = DATA[appId];
      const results =
        kind === "funnel"
          ? [funnelResult(data, values)]
          : data
            ? data[kind]
            : [];
      console.error(`[mock-posthog] ${kind.padEnd(11)} app=${String(appId).slice(0, 8)} -> ${results.length} row(s)`);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ results }));
    });
  })
  .listen(port, () => console.error(`[mock-posthog] listening on http://localhost:${port}`));
