// Opt-in host-side controller for a real OOM in a disposable runner only.
// STERRACODE_OOM_RUNNER=sterra-smoke-<8hex>-runner-1
// STERRACODE_OOM_APP_URL=http://127.0.0.1:<test-port> node tests/docker/oom-live.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

const runner = process.env.STERRACODE_OOM_RUNNER;
if (!runner) {
  console.log(
    JSON.stringify({
      skipped: true,
      reason: "Set STERRACODE_OOM_RUNNER for an isolated, bounded OOM test.",
    }),
  );
  process.exit(0);
}
assert.match(
  runner,
  /^sterra-(?:smoke|oom)-[a-f0-9]{8}-runner-1$/,
  "Only disposable test runners may be stressed",
);
const app = new URL(process.env.STERRACODE_OOM_APP_URL);
assert(["127.0.0.1", "localhost", "[::1]"].includes(app.hostname));
function docker(args) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 8 * 1024 ** 2,
  });
  if (result.status !== 0)
    throw new Error(
      `${args.slice(0, 3).join(" ")}: ${result.stderr || result.error?.message}`,
    );
  return result.stdout.trim();
}
const inspect = JSON.parse(docker(["inspect", runner]))[0];
const limit = inspect.HostConfig.Memory,
  originalSwap = inspect.HostConfig.MemorySwap;
assert(
  Number.isInteger(limit) && limit >= 256 * 1024 ** 2 && limit <= 2 * 1024 ** 3,
  "A finite memory limit <= 2 GiB is required",
);
assert.match(
  inspect.Config.Labels["com.docker.compose.project"],
  /^sterra-(?:smoke|oom)-[a-f0-9]{8}$/,
);
let sampling = false,
  samples = [],
  workerOutput = "",
  workerError = "";
async function health() {
  const response = await fetch(new URL("/api/health", app), {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  samples.push({ at: new Date().toISOString(), status: response.status });
}

const worker = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {removeTree} from '/app/runner/common.js';
const read=async n=>(await fs.readFile('/sys/fs/cgroup/'+n,'utf8')).trim();
const max=Number(await read('memory.max')); assert(max>0&&max<=2147483648); assert.equal(await read('memory.swap.max'),'0');
const available=Number((await fs.readFile('/proc/meminfo','utf8')).match(/^MemAvailable:\s+(\d+)/m)[1])*1024; assert(available>max*2,'Host needs at least twice the runner budget available');
const counters=async()=>Object.fromEntries((await read('memory.events')).split('\n').map(x=>{const [k,v]=x.split(' ');return[k,Number(v)]}));
const before=await counters();
const secret=(await fs.readFile(process.env.STERRACODE_RUNNER_SECRET_FILE||'/run/secrets/runner_key','utf8')).trim();
const api=async(p,m='GET',b)=>{const r=await fetch('http://127.0.0.1:3001/v1'+p,{method:m,headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined,signal:AbortSignal.timeout(10000)});const v=await r.json();if(!r.ok)throw Error(r.status+' '+JSON.stringify(v));return v};
assert.equal((await api('/status')).status,'ready');
const sessionId=randomUUID(),id=randomUUID(),workspaceRoot=process.env.STERRACODE_WORKSPACE_DIR||'/workspaces',workspace=path.join(workspaceRoot,sessionId);
await fs.mkdir(workspace,{mode:0o2770});await fs.chown(workspace,10001,10001);await fs.chmod(workspace,0o2770);
try{
  const source='const held=[];for(let i=0;i<37;i++){held.push(Buffer.alloc(64*1024*1024,1));console.log("allocatedMiB="+held.length*64)}setInterval(()=>{},1000)';
  const command='node -e '+"'"+source.replaceAll("'",'"')+"'";
  await api('/jobs','POST',{id,sessionId,type:'command',command,actor:'user',executionTimeout:20000,compilationTimeout:60000});
  console.log(JSON.stringify({started:id,sessionId}));
  const deadline=Date.now()+25000; let job;
  while(Date.now()<deadline){job=await api('/jobs/'+id+'/output?sessionId='+sessionId);if(job.exited)break;await new Promise(r=>setTimeout(r,100))}
  if(!job?.exited){await api('/jobs/'+id,'DELETE',{sessionId});throw Error('OOM job exceeded its bounded test window')}
  const after=await counters();assert(after.oom_kill>before.oom_kill,JSON.stringify({before,after,job}));
  assert.equal(job.exitCode,137,job.output);assert.equal(job.state,'failed');assert.equal(job.reason,'resource_limit_or_sigkill');
  assert((await api('/health')).ok);
  console.log(JSON.stringify({ok:true,at:new Date().toISOString(),memoryMax:max,swapMax:0,hostAvailableBytes:available,before,after,job:{processId:id,state:job.state,exitCode:job.exitCode,reason:job.reason,allocationProgress:job.output.trim().split('\n').at(-1)},runnerStatus:(await api('/status')).status}));
}finally{await api('/sessions/'+sessionId+'/block','POST',{});await removeTree(workspaceRoot,sessionId)}
`;

try {
  await health();
  // Docker otherwise permits another 2 GiB of swap beside a 2 GiB RAM budget.
  // Change only this disposable container and restore its previous setting.
  docker(["update", "--memory-swap", String(limit), runner]);
  sampling = true;
  const monitor = (async () => {
    while (sampling) {
      await health();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  let timer;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        "docker",
        ["exec", "-i", runner, "node", "--input-type=module"],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      child.stdout.on("data", (chunk) => {
        workerOutput += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        workerError += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                `OOM worker exited ${code}: ${workerError}\n${workerOutput}`,
              ),
            ),
      );
      child.stdin.end(worker);
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(
          new Error("OOM worker exceeded the external 30-second deadline"),
        );
      }, 30000);
    });
  } finally {
    clearTimeout(timer);
    sampling = false;
    await monitor;
  }
  await health();
  const result = workerOutput
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((entry) => entry.ok);
  assert(result);
  assert(samples.length >= 3);
  console.log(
    JSON.stringify(
      {
        ...result,
        appHealth: {
          allSuccessful: true,
          samples: samples.length,
          before: samples[0],
          after: samples.at(-1),
        },
      },
      null,
      2,
    ),
  );
} finally {
  docker(["update", "--memory-swap", String(originalSwap), runner]);
}
