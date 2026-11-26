import { ModalClient } from "modal";
const m = new ModalClient();
const app = await m.apps.fromName("kennel-diag", { createIfMissing: true });
const image = await m.images.fromName("kennel-agent-v2");
const secrets = [await m.secrets.fromName("openai-eval-key"), await m.secrets.fromName("fish-audio-api-key")];
const sb = await m.sandboxes.create(app, image, { secrets, timeoutMs: 1800_000, cpu: 2, memoryMiB: 4096, env: { HOME: "/var/kennel/home", IS_SANDBOX: "1" } });
console.log("sandbox", sb.sandboxId);
const script = String.raw`
set -u; mkdir -p $HOME /tmp/pw && cd /tmp/pw
echo "HOME=$HOME PATH=$PATH"
echo "bun $(bun --version) at $(command -v bun); bunx at $(command -v bunx)"
echo "node $(node --version); claude $(claude --version 2>&1 | head -1)"
for k in OPENAI_API_KEY FISH_AUDIO_API_KEY; do if [ -n "$(printenv $k)" ]; then echo "$k present"; else echo "$k MISSING"; fi; done
echo '{"name":"pw","private":true}' > package.json
bun add -d playwright@1.62.1 >/dev/null 2>&1; echo "bunx playwright: $(bunx playwright --version)"
cat > shot.mjs <<'JS'
import { chromium } from "playwright";
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setContent("<h1 style='font-family:sans-serif'>kennel ok \u2705 \u4e2d\u6587</h1>");
await p.screenshot({ path: "/tmp/pw/shot.png" });
console.log("title-ok", await p.evaluate(() => document.fonts.size >= 0));
await b.close();
JS
bun shot.mjs && ls -la /tmp/pw/shot.png && file /tmp/pw/shot.png 2>/dev/null
df -h / | tail -1
`;
const p = await sb.exec(["bash", "-lc", script], { stdout: "pipe", stderr: "pipe" });
const [out, err] = await Promise.all([p.stdout.readText(), p.stderr.readText()]);
console.log(out); console.error(err.slice(-2000)); console.log("exit", await p.wait());
await sb.terminate();
