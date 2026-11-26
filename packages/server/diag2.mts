import { ModalClient } from "modal";
const m = new ModalClient();
const app = await m.apps.fromName("kennel-diag", { createIfMissing: true });
const image = await m.images.fromName(process.argv[2] ?? "kennel-env-tag-d02a712ed226");
const vol = await m.volumes.fromName("kennel-diag-vol2", { createIfMissing: true, version: 2 });
const gh = await m.secrets.fromName("kennel-build");
const sb = await m.sandboxes.create(app, image, { volumes: { "/var/kennel": vol }, secrets: [gh], timeoutMs: 3600_000, cpu: 8, memoryMiB: 16384 });
console.log("sandbox", sb.sandboxId);
const script = String.raw`
set -u
df -h /var/kennel; df -i /var/kennel
cd /var/kennel && rm -rf diag && mkdir diag && cd diag
git -c credential.helper='!f(){ echo username=x-access-token; echo password=$GITHUB_TOKEN; };f' clone -q --depth 1 https://github.com/BentoLabs-ai/tag repo 2>&1 | tail -2
cd repo
export BUN_INSTALL_CACHE_DIR=/tmp/kennel-cache/bun
start=$(date +%s); timeout 1500 bun install --frozen-lockfile > /tmp/install.log 2>&1; echo "install rc=$? secs=$(( $(date +%s)-start ))"; tail -3 /tmp/install.log
df -h /var/kennel; df -i /var/kennel; df -h /
echo "node_modules files: $(find node_modules | wc -l)"; du -sh node_modules /tmp/kennel-cache/bun
start=$(date +%s); timeout 900 bun install --frozen-lockfile > /tmp/install3.log 2>&1; echo "reinstall rc=$? secs=$(( $(date +%s)-start ))"
`;
const p = await sb.exec(["bash","-lc", script], { stdout: "pipe", stderr: "pipe" });
const [out, err] = await Promise.all([p.stdout.readText(), p.stderr.readText()]);
console.log(out); console.error(err.slice(-3000));
console.log("exit", await p.wait());
await sb.terminate();
