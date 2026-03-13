/**
 * Minimal Node server for testing Hostinger deployment.
 * If this works but index.js doesn't, the issue is in our app code.
 * In Hostinger Settings → Entry file: change to "server-minimal.js" to test.
 */
import http from "http";
const port = process.env.PORT || 4000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, test: "minimal" }));
});
server.listen(port, "0.0.0.0", () => {
  console.log(`[MINIMAL] Listening on port ${port}`);
});
