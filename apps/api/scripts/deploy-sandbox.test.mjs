import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkSnapshot, deploymentConfig, executeDeployment } from "./deploy-sandbox.mjs";

const kind = "service",
  sha = "a".repeat(40),
  version = "11111111-1111-4111-8111-111111111111";
const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_RUN_ID: "123",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  SANDBOX_DEPLOY_ENABLED: "true",
  GITHUB_SHA: sha,
  DEPLOY_SHA: sha,
  GITHUB_REPOSITORY: "synthetic/repo",
  DEPLOY_REVIEWER: "owner",
  DEPLOY_OPERATION: "deploy",
  DEPLOY_CONFIRMATION: `deploy:${sha}`,
  MAINTENANCE_CONFIRMED: "true",
  SCHEMA_CONFIRMED: "true",
  GH_TOKEN: "synthetic-github-secret",
  CLOUDFLARE_API_TOKEN: "synthetic-cloudflare-secret",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CF_WORKER_SUBDOMAIN: "synthetic",
  CF_QUEUE_ID: "b".repeat(32),
  WORKER_NAME: kind === "service" ? "notification-service" : "notification-worker",
  D1_DATABASE_ID: "22222222-2222-4222-8222-222222222222",
  X_USER_ID: "123",
  RELAY_URL: "https://relay.example.invalid",
};
function fixture({ mutate = () => {}, versionID = version, dirty = false, migrate = false } = {}) {
  const selectedEnv = migrate
    ? {
        ...env,
        DEPLOY_OPERATION: "migrate",
        DEPLOY_CONFIRMATION: `migrate:${sha}`,
        BACKUP_CONFIRMED: "true",
        SCHEMA_CONFIRMED: "false",
      }
    : env;
  const { config } = deploymentConfig(env);
  const secrets =
    kind === "worker"
      ? ["RELAY_TOKEN", "X_EVENT_ID_SECRET", "X_OAUTH2_CLIENT_SECRET"]
      : [
          "APNS_PROVIDER_KEYS",
          "CHALLENGE_SIGNING_KEY",
          "DEVICE_TOKEN_FINGERPRINT_KEY",
          "DEVICE_TOKEN_KEYS",
          "ENROLLMENT_INVITE_CODE",
        ];
  const snapshot = {
    bindings: [
      ...Object.entries(config.vars).map(([name, text]) => ({ name, text, type: "plain_text" })),
      ...secrets.map((name) => ({ name, type: "secret_text" })),
      { name: "DB", type: "d1", id: env.D1_DATABASE_ID },
      {
        name: config.queues.producers[0].binding,
        type: "queue",
        queue_name: config.queues.producers[0].queue,
      },
    ],
  };
  const calls = [];
  let mutations = 0;
  return {
    snapshot,
    env: selectedEnv,
    calls,
    count: () => mutations,
    fetchImpl: async (url, options) => {
      calls.push(url);
      const u = new URL(url);
      assert.equal(options.redirect, "error");
      if (u.hostname === "api.github.com") {
        assert.equal(options.headers.Authorization, "Bearer synthetic-github-secret");
        if (u.pathname.endsWith("/approvals"))
          return Response.json([
            {
              state: "approved",
              user: { login: "owner" },
              environments: [{ name: migrate ? "sandbox-migrations" : "sandbox" }],
            },
          ]);
        if (u.pathname.endsWith(migrate ? "/sandbox-migrations" : "/sandbox"))
          return Response.json({
            name: migrate ? "sandbox-migrations" : "sandbox",
            protection_rules: [
              {
                type: "required_reviewers",
                reviewers: [{ type: "User", reviewer: { login: "owner" } }],
              },
            ],
            deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
          });
        if (u.pathname.endsWith("deployment-branch-policies"))
          return Response.json({
            total_count: 1,
            branch_policies: [{ name: "main", type: "branch" }],
          });
        return Response.json({
          workflow_runs: [
            {
              head_sha: sha,
              event: "push",
              head_branch: "main",
              status: "completed",
              conclusion: "success",
            },
          ],
        });
      }
      if (u.hostname === "api.cloudflare.com") {
        assert.equal(options.headers.Authorization, "Bearer synthetic-cloudflare-secret");
        let result;
        if (u.pathname.includes("/d1/database/"))
          result = { uuid: env.D1_DATABASE_ID, name: "notification-service" };
        else if (u.pathname.endsWith("/settings")) result = structuredClone(snapshot);
        else if (u.pathname.endsWith("/metrics")) result = { backlog_count: 0, backlog_bytes: 0 };
        else if (u.pathname.endsWith("/deployments"))
          result = { deployments: [{ versions: [{ version_id: versionID, percentage: 100 }] }] };
        else if (u.pathname.endsWith("/schedules"))
          result = { schedules: config.triggers.crons.map((cron) => ({ cron })) };
        else result = { queue_name: config.queues.producers[0].queue };
        mutate(u, result);
        return Response.json({ success: true, result });
      }
      assert.equal(options.headers, undefined);
      assert.equal(u.origin, `https://${env.WORKER_NAME}.synthetic.workers.dev`);
      return new Response(null, { status: u.pathname === "/health" ? 200 : 404 });
    },
    runCommand: (command, args, options) => {
      if (command === "git")
        return { status: 0, stdout: args[0] === "rev-parse" ? sha : dirty ? "modified" : "" };
      assert.equal(command, "pnpm");
      mutations++;
      const written = JSON.parse(readFileSync(args.at(-1), "utf8"));
      assert.equal(written.preview_urls, false);
      assert.equal(JSON.stringify(written).includes("secret"), false);
      assert.equal(options.env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_ACCOUNT_ID);
      assert.equal(options.env.GH_TOKEN, undefined);
      if (migrate) assert.ok(args.includes("migrations") && args.includes("--remote"));
      return { status: 0, stdout: `Current Version ID: ${version}\nprivate value never printed` };
    },
  };
}
test("停止中sandboxを更新し、稼働版・設定・Queue・Cron・公開入口を確認する", async () => {
  const f = fixture();
  const result = await executeDeployment(env, f);
  assert.equal(f.count(), 1);
  assert.equal(result.status, "sandbox_deployed");
  assert.equal(result.version, version);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
for (const [name, options] of [
  [
    "Queue滞留",
    {
      mutate: (url, data) => {
        if (url.pathname.endsWith("/metrics")) data.backlog_count = 1;
      },
    },
  ],
  [
    "別Queue",
    {
      mutate: (_url, data) => {
        if ("queue_name" in data) data.queue_name = "other";
      },
    },
  ],
  [
    "secret欠落",
    {
      mutate: (_url, data) => {
        if (data.bindings)
          data.bindings = data.bindings.filter((value) => value.type !== "secret_text");
      },
    },
  ],
  [
    "設定違い",
    {
      mutate: (_url, data) => {
        if (data.bindings)
          data.bindings.find((value) => value.type === "plain_text").text = "other";
      },
    },
  ],
  ["未コミット変更", { dirty: true }],
])
  test(`${name}では配置しない`, async () => {
    const f = fixture(options);
    await assert.rejects(executeDeployment(env, f));
    assert.equal(f.count(), 0);
  });
test("配置成功後も稼働版が一致しなければ成功としない", async () => {
  const f = fixture({ versionID: "33333333-3333-4333-8333-333333333333" });
  await assert.rejects(executeDeployment(env, f));
  assert.equal(f.count(), 1);
});
for (const [key, value] of Object.entries({
  CLOUDFLARE_ACCOUNT_ID: "../other",
  CF_WORKER_SUBDOMAIN: "other.invalid/path",
  CF_QUEUE_ID: "bad",
  WORKER_NAME: "bad/name",
}))
  test(`${key}の不正値を設定へ入れない`, () => {
    assert.throws(() => deploymentConfig({ ...env, [key]: value }));
  });

test("migrationは別Environmentで確認し、D1操作だけを実行する", async () => {
  const f = fixture({ migrate: true });
  const result = await executeDeployment(f.env, f);
  assert.equal(result.status, "migration_applied");
  assert.equal(f.count(), 1);
  assert.equal(f.calls.filter((url) => url.startsWith("https://api.cloudflare.com")).length, 1);
});

test("KCVの安全な追加は配置前に許可し、配置後は完全一致を求める", () => {
  const f = fixture();
  const { config } = deploymentConfig(env);
  const next = structuredClone(config);
  const checks = JSON.parse(next.vars.DEVICE_TOKEN_KEY_CHECKS);
  checks.keys["synthetic-new-key"] = "1111111111111111";
  next.vars.DEVICE_TOKEN_KEY_CHECKS = JSON.stringify(checks);
  assert.doesNotThrow(() => checkSnapshot(f.snapshot, next, { before: true }));
  assert.throws(() => checkSnapshot(f.snapshot, next));
});
test("App Attestの許可バージョン追加は配置前に許可する", () => {
  const f = fixture();
  const { config } = deploymentConfig(env);
  const next = structuredClone(config);
  const policy = JSON.parse(next.vars.APP_ATTEST_POLICY);
  policy.bundleVersions.push("2");
  next.vars.APP_ATTEST_POLICY = JSON.stringify(policy);
  assert.doesNotThrow(() => checkSnapshot(f.snapshot, next, { before: true }));
  assert.throws(() => checkSnapshot(f.snapshot, next));
});

for (const [name, change] of [
  [
    "指紋鍵KCV変更",
    (checks) => {
      checks.fingerprint = "ffffffffffffffff";
    },
  ],
  [
    "旧暗号鍵のKCV変更",
    (checks) => {
      checks.keys[Object.keys(checks.keys)[0]] = "ffffffffffffffff";
    },
  ],
  [
    "旧暗号鍵の削除",
    (checks) => {
      delete checks.keys[Object.keys(checks.keys)[0]];
    },
  ],
])
  test(`${name}は通常配置で許可しない`, () => {
    const f = fixture();
    const { config } = deploymentConfig(env);
    const checks = JSON.parse(config.vars.DEVICE_TOKEN_KEY_CHECKS);
    change(checks);
    config.vars.DEVICE_TOKEN_KEY_CHECKS = JSON.stringify(checks);
    assert.throws(() => checkSnapshot(f.snapshot, config, { before: true }));
  });
for (const [name, change] of [
  [
    "App ID変更",
    (policy) => {
      policy.appId = "other.example";
    },
  ],
  [
    "productionへ変更",
    (policy) => {
      policy.environment = "production";
    },
  ],
  [
    "requiredへ変更",
    (policy) => {
      policy.mode = "required";
    },
  ],
  [
    "既存バージョンの削除",
    (policy) => {
      policy.bundleVersions = ["other"];
    },
  ],
])
  test(`${name}は通常配置で許可しない`, () => {
    const f = fixture();
    const { config } = deploymentConfig(env);
    const policy = JSON.parse(config.vars.APP_ATTEST_POLICY);
    change(policy);
    config.vars.APP_ATTEST_POLICY = JSON.stringify(policy);
    assert.throws(() => checkSnapshot(f.snapshot, config, { before: true }));
  });

for (const id of ["bad key", "k".repeat(33)])
  test(`不正な暗号鍵IDの追加を拒否する ${id}`, () => {
    const f = fixture();
    const { config } = deploymentConfig(env);
    const checks = JSON.parse(config.vars.DEVICE_TOKEN_KEY_CHECKS);
    checks.keys[id] = "1111111111111111";
    config.vars.DEVICE_TOKEN_KEY_CHECKS = JSON.stringify(checks);
    assert.throws(() => checkSnapshot(f.snapshot, config, { before: true }));
  });
for (const version of ["x".repeat(129), ""])
  test(`実行時に読めないバージョンの追加を拒否する ${version.length}`, () => {
    const f = fixture();
    const { config } = deploymentConfig(env);
    const policy = JSON.parse(config.vars.APP_ATTEST_POLICY);
    policy.bundleVersions.push(version);
    config.vars.APP_ATTEST_POLICY = JSON.stringify(policy);
    assert.throws(() => checkSnapshot(f.snapshot, config, { before: true }));
  });
test("100件を超える許可バージョンを配置しない", () => {
  const f = fixture();
  const { config } = deploymentConfig(env);
  const policy = JSON.parse(config.vars.APP_ATTEST_POLICY);
  policy.bundleVersions.push(...Array.from({ length: 100 }, (_, i) => String(i + 2)));
  config.vars.APP_ATTEST_POLICY = JSON.stringify(policy);
  assert.throws(() => checkSnapshot(f.snapshot, config, { before: true }));
});
test("上限内の鍵IDとバージョン追加を許可する", () => {
  const f = fixture();
  const { config } = deploymentConfig(env);
  const checks = JSON.parse(config.vars.DEVICE_TOKEN_KEY_CHECKS);
  checks.keys["k".repeat(32)] = "1111111111111111";
  config.vars.DEVICE_TOKEN_KEY_CHECKS = JSON.stringify(checks);
  const policy = JSON.parse(config.vars.APP_ATTEST_POLICY);
  policy.bundleVersions.push("x".repeat(128));
  config.vars.APP_ATTEST_POLICY = JSON.stringify(policy);
  assert.doesNotThrow(() => checkSnapshot(f.snapshot, config, { before: true }));
});
