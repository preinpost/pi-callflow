// Standalone end-to-end smoke test: opens the real viewer with a history of diagrams
// and handles prev/next navigation. Auto-closes after a few seconds so it never hangs.
import { readFileSync } from "node:fs";
import { open } from "glimpseui";

const html = readFileSync(new URL("../web/dist/index.html", import.meta.url), "utf8");

const diagrams = [
  {
    title: "Login → OTP verification flow (sample #1)",
    sequence: `sequenceDiagram
    participant C as Client
    participant A as AuthController
    participant R as RegisterAuthenticator
    participant O as OtpService
    C->>A: POST /auth/authorize (grant)
    A->>R: validate(userid, pw)
    R-->>A: TRUE / UNSET_MFA / OTP_REQUIRED
    A->>O: verifyOTPCode(userid, mfa)
    O-->>A: ok
    A-->>C: SUCCESS (tokens)`,
    flowchart: `flowchart TD
    G[grant] -->|mfa_type=null| U[UNSET_MFA]
    G -->|mfa_type=otp| Q[OTP_REQUIRED]
    U --> M[mfa] --> OK[SUCCESS]
    Q --> M`,
    steps: [
      { index: 1, from: "Client", to: "AuthController", call: "POST /auth/authorize", file: "server/.../AuthController.java", line: 88, note: "response_type=grant" },
      { index: 2, from: "AuthController", to: "RegisterAuthenticator", call: "validate()", file: "server/.../RegisterAuthenticator.java", line: 142 },
      { index: 3, from: "AuthController", to: "OtpService", call: "verifyOTPCode()", file: "server/.../OtpService.java", line: 61 },
    ],
    notes: "REQUIRE_MFA=true → branches on mfa_type.",
    generatedAt: Date.now(),
  },
  {
    title: "Token refresh flow (sample #2, sequence only)",
    sequence: `sequenceDiagram
    participant C as Client
    participant A as AuthController
    participant T as TokenService
    C->>A: POST /auth/authorize (token)
    A->>T: issueVolatilityToken()
    T-->>A: token
    A-->>C: token`,
    steps: [
      { index: 1, from: "Client", to: "AuthController", call: "POST /auth/authorize", file: "server/.../AuthController.java", line: 120 },
      { index: 2, from: "AuthController", to: "TokenService", call: "issueVolatilityToken()", file: "server/.../TokenService.java", line: 44 },
    ],
    notes: "No flowchart for this one (sequence-only path).",
    generatedAt: Date.now(),
  },
];

// Minimal history mirror of CallflowController for the smoke test.
let cursor = 0;
const esc = (s) => s.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
const win = open(html, { width: 1280, height: 900, title: "Call Flow (smoke)" });

function sendCurrent() {
  const msg = { type: "diagram", diagram: diagrams[cursor], index: cursor, total: diagrams.length };
  win.send(`window.__callflowReceive(${esc(JSON.stringify(msg))})`);
}

win.on("message", (data) => {
  if (!data || typeof data.type !== "string") return;
  if (data.type === "ready") {
    win.send(`window.__callflowReceive(${esc(JSON.stringify({ type: "editors", list: [{ id: "code", label: "VS Code" }, { id: "idea", label: "IntelliJ IDEA" }], selected: "code", locked: false }))})`);
    sendCurrent();
  }
  else if (data.type === "set-editor") console.log("set-editor →", data.id);
  else if (data.type === "navigate") {
    const next = cursor + (data.direction === "next" ? 1 : -1);
    if (next >= 0 && next < diagrams.length) { cursor = next; sendCurrent(); console.log("navigate →", cursor); }
  } else if (data.type === "open-file") console.log("open-file requested:", data.file, data.line);
});
win.on("error", (e) => { console.error("window error:", e.message); process.exit(1); });

// Auto-advance once to prove history works, then close.
setTimeout(() => { cursor = 1; sendCurrent(); }, 1500);
setTimeout(() => { try { win.close(); } catch {} console.log("smoke ok"); process.exit(0); }, 4000);
