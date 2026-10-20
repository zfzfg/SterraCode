export const volumeKeys = [
  "app-data",
  "workspaces",
  "runner-state",
  "package-cache",
  "tool-cache",
  "runs",
  "app-key",
  "runner-key",
];
export function deployment(config, release, volumes) {
  const mount = (key, target, readOnly = false) => ({
    type: "volume",
    source: key,
    target,
    read_only: readOnly,
  });
  const security = {
    init: true,
    security_opt: ["no-new-privileges:true"],
    restart: "unless-stopped",
    stop_grace_period: "30s",
    logging: {
      driver: "json-file",
      options: { "max-size": "10m", "max-file": "3" },
    },
  };
  const appVolumes = [
    mount("app-data", "/data"),
    mount("workspaces", "/workspaces"),
    mount("app-key", "/run/secrets", true),
  ];
  const adminVolumes = volumeKeys
    .filter((k) => !["runs", "tool-cache"].includes(k))
    .map((k) => mount(k, k === "app-data" ? "/data" : `/${k}`));
  const check = (code, start = "20s") => ({
    test: ["CMD", "node", "-e", code],
    interval: "15s",
    timeout: "5s",
    start_period: start,
    retries: 4,
  });
  return {
    name: config.project,
    services: {
      init: {
        image: release.images.app,
        user: "0:0",
        command: ["node", "docker/admin.mjs", "init"],
        environment: { STERRACODE_ADMIN_ENGLISH: "1" },
        network_mode: "none",
        read_only: true,
        cap_drop: ["ALL"],
        cap_add: ["CHOWN", "FOWNER", "DAC_OVERRIDE"],
        security_opt: security.security_opt,
        volumes: volumeKeys.map((k) =>
          mount(k, k === "app-data" ? "/data" : `/${k}`),
        ),
      },
      app: {
        ...security,
        image: release.images.app,
        user: "10001:10001",
        read_only: true,
        cap_drop: ["ALL"],
        tmpfs: ["/tmp:size=64m,mode=1777,noexec,nosuid,nodev"],
        mem_limit: "1g",
        memswap_limit: "1g",
        pids_limit: 128,
        depends_on: {
          init: { condition: "service_completed_successfully" },
          runner: { condition: "service_started" },
        },
        environment: {
          NODE_ENV: "production",
          STERRACODE_MODE: "docker",
          HOST: "0.0.0.0",
          PORT: "3000",
          STERRACODE_DATA_DIR: "/data",
          STERRACODE_WORKSPACE_DIR: "/workspaces",
          STERRACODE_PUBLIC_URL: config.publicURL,
          STERRACODE_LM_STUDIO_URL:
            config.lmStudioURL || "http://host.docker.internal:1234",
          STERRACODE_RUNNER_URL: "http://runner:3001",
          STERRACODE_RUNNER_SECRET_FILE: "/run/secrets/runner_key",
          STERRACODE_UPDATER_URL: "http://updater:3002",
          STERRACODE_UPDATER_SECRET_FILE: "/run/updater/key",
          STERRACODE_UPDATE_PENDING: "1",
        },
        extra_hosts: ["host.docker.internal:host-gateway"],
        volumes: [...appVolumes, mount("updater-key", "/run/updater", true)],
        networks: ["backend"],
        ports: [`${config.bindIP}:${config.port}:3000`],
        healthcheck: check(
          "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
        ),
      },
      runner: {
        ...security,
        image: release.images.runner,
        user: "0:0",
        mem_limit: "2g",
        memswap_limit: "2g",
        pids_limit: 256,
        depends_on: { init: { condition: "service_completed_successfully" } },
        environment: { RUNNER_IMAGE_DIGEST: release.images.runner },
        volumes: [
          "workspaces",
          "runner-state",
          "package-cache",
          "tool-cache",
          "runs",
        ]
          .map((k) => mount(k, `/${k}`))
          .concat(mount("runner-key", "/run/secrets", true)),
        networks: ["backend"],
        healthcheck: check(
          "const fs=require('node:fs');fetch('http://127.0.0.1:3001/v1/health',{headers:{authorization:'Bearer '+fs.readFileSync('/run/secrets/runner_key','utf8').trim()}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
          "30s",
        ),
      },
      admin: {
        profiles: ["tools"],
        image: release.images.app,
        user: "0:0",
        read_only: true,
        cap_drop: ["ALL"],
        cap_add: ["CHOWN", "FOWNER", "DAC_OVERRIDE"],
        security_opt: security.security_opt,
        network_mode: "none",
        entrypoint: ["node", "docker/admin.mjs"],
        environment: { STERRACODE_ADMIN_ENGLISH: "1" },
        volumes: adminVolumes,
        tmpfs: ["/tmp:size=64m,mode=1777,noexec,nosuid,nodev"],
      },
    },
    networks: { backend: { name: `${config.project}_backend` } },
    volumes: Object.fromEntries([
      ...volumeKeys.map((k) => [k, { name: volumes[k], external: true }]),
      [
        "updater-key",
        { name: `${config.project}_updater-key`, external: true },
      ],
    ]),
  };
}
