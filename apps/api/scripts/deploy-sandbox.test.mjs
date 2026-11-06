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
const productionEnv = {
  ...env,
  SANDBOX_DEPLOY_ENABLED: "false",
  PRODUCTION_VERIFICATION_DEPLOY_ENABLED: "true",
  WORKER_NAME: "notification-service-prod-verification",
  PROD_BUNDLE_VERSION: "1",
  PROD_DEVICE_TOKEN_KEY_CHECKS: JSON.stringify({
    fingerprint: "0123456789abcdef",
    keys: { "prod-verification": "fedcba9876543210" },
  }),
};
const publicEnv = {
  ...productionEnv,
  PRODUCTION_VERIFICATION_DEPLOY_ENABLED: "false",
  PUBLIC_PRODUCTION_DEPLOY_ENABLED: "true",
  WORKER_NAME: "notification-service-production",
  PROD_BUNDLE_VERSION: "2",
  VERIFICATION_DEVICE_TOKEN_KEY_CHECKS: productionEnv.PROD_DEVICE_TOKEN_KEY_CHECKS,
  PROD_DEVICE_TOKEN_KEY_CHECKS: JSON.stringify({
    fingerprint: "1111222233334444",
    keys: { production: "5555666677778888" },
  }),
};
function fixture({
  mutate = () => {},
  versionID = version,
  dirty = false,
  migrate = false,
  productionVerification = false,
  publicProduction = false,
  bootstrap = false,
  edgeForbidden = false,
  trial = {},
} = {}) {
  const targetEnv = publicProduction
    ? { ...publicEnv, ...trial }
    : productionVerification
      ? productionEnv
      : env;
  const target = publicProduction
    ? "production"
    : productionVerification
      ? "production-verification"
      : "sandbox";
  const environment = migrate ? `${target}-migrations` : target;
  const selectedEnv = migrate
    ? {
        ...targetEnv,
        DEPLOY_OPERATION: "migrate",
        DEPLOY_CONFIRMATION: `migrate:${sha}`,
        BACKUP_CONFIRMED: "true",
        SCHEMA_CONFIRMED: "false",
      }
    : targetEnv;
  const { config } = deploymentConfig(targetEnv, { productionVerification, publicProduction });
  const secrets =
    kind === "worker"
      ? ["RELAY_TOKEN", "X_EVENT_ID_SECRET", "X_OAUTH2_CLIENT_SECRET"]
      : [
          "APNS_PROVIDER_KEYS",
          "CHALLENGE_SIGNING_KEY",
          "DEVICE_TOKEN_FINGERPRINT_KEY",
          "DEVICE_TOKEN_KEYS",
          ...(publicProduction ? [] : ["ENROLLMENT_INVITE_CODE"]),
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
    productionVerification,
    publicProduction,
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
              environments: [{ name: environment }],
            },
          ]);
        if (u.pathname.endsWith(`/${environment}`))
          return Response.json({
            name: environment,
            can_admins_bypass: false,
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
        if (u.pathname.endsWith("/query")) {
          assert.equal(options.method, "POST");
          assert.deepEqual(JSON.parse(options.body), {
            sql: "SELECT EXISTS(SELECT 1 FROM notification_accounts) AS has_accounts",
          });
          result = [{ success: true, results: [{ has_accounts: 0 }] }];
        } else if (u.pathname.includes("/d1/database/"))
          result = { uuid: env.D1_DATABASE_ID, name: config.d1_databases[0].database_name };
        else if (u.pathname.endsWith("/settings")) {
          result = structuredClone(snapshot);
          if (mutations === 0)
            result.bindings = result.bindings.filter((binding) => binding.name !== "PUBLIC_TRIAL");
          if (bootstrap && mutations === 0) {
            result.bindings = result.bindings.filter((binding) => binding.type === "secret_text");
            result.bindings.push({
              name: publicProduction
                ? "PUBLIC_PRODUCTION_BOOTSTRAP"
                : "PRODUCTION_VERIFICATION_BOOTSTRAP",
              type: "plain_text",
              text: "true",
            });
          }
        } else if (u.pathname.endsWith("/metrics")) result = { backlog_count: 0, backlog_bytes: 0 };
        else if (u.pathname.endsWith("/deployments"))
          result = { deployments: [{ versions: [{ version_id: versionID, percentage: 100 }] }] };
        else if (u.pathname.endsWith("/schedules"))
          result = { schedules: config.triggers.crons.map((cron) => ({ cron })) };
        else if (u.pathname.endsWith(`/workers/workers/${config.name}`))
          result = {
            name: config.name,
            subdomain: {
              url: `https://${config.name}.${targetEnv.CF_WORKER_SUBDOMAIN}.workers.dev`,
            },
          };
        else if (u.pathname.endsWith("/workers/subdomain"))
          return new Response(null, { status: 403 });
        else {
          const empty = bootstrap && mutations === 0;
          result = {
            queue_id: targetEnv.CF_QUEUE_ID,
            queue_name: config.queues.producers[0].queue,
            producers_total_count: empty ? 0 : 1,
            consumers_total_count: empty ? 0 : 1,
            producers: empty ? [] : [{ type: "worker", script: config.name }],
            consumers: empty ? [] : [{ type: "worker", script: config.name }],
          };
        }
        mutate(u, result);
        return Response.json({ success: true, result });
      }
      assert.equal(options.headers?.Authorization, undefined);
      if (publicProduction && u.pathname === "/v1/enrollments") {
        assert.equal(options.method, "POST");
        assert.equal(options.headers["Content-Type"], "application/json");
        assert.deepEqual(JSON.parse(options.body), {
          challenge: "",
          public_key: "",
          signature: "",
        });
        if (edgeForbidden) return new Response("Forbidden", { status: 403 });
        return Response.json(
          { status: 403, detail: "Enrollment is not available.", request_id: version },
          {
            status: 403,
            headers: { "Content-Type": "application/problem+json", "X-Request-Id": version },
          },
        );
      }
      assert.equal(options.headers, undefined);
      assert.equal(u.origin, `https://${targetEnv.WORKER_NAME}.synthetic.workers.dev`);
      return new Response(null, { status: u.pathname === "/health" ? 200 : 404 });
    },
    runCommand: (command, args, options) => {
      if (command === "git")
        return { status: 0, stdout: args[0] === "rev-parse" ? sha : dirty ? "modified" : "" };
      assert.equal(command, "pnpm");
      mutations++;
      const written = JSON.parse(readFileSync(args.at(-1), "utf8"));
      assert.equal(written.preview_urls, false);
      assert.equal(written.name, targetEnv.WORKER_NAME);
      assert.equal(written.d1_databases[0].database_name, config.d1_databases[0].database_name);
      assert.equal(JSON.stringify(written).includes("secret"), false);
      assert.equal(options.env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_ACCOUNT_ID);
      assert.equal(options.env.GH_TOKEN, undefined);
      if (migrate) assert.ok(args.includes("migrations") && args.includes("--remote"));
      return { status: 0, stdout: `Current Version ID: ${version}\nprivate value never printed` };
    },
  };
}
test("production検証ではsandboxの資源・鍵の確認値・承認を使わない", async () => {
  const f = fixture({ productionVerification: true, bootstrap: true });
  const { config } = deploymentConfig(f.env, f);
  assert.deepEqual(JSON.parse(config.vars.APP_ATTEST_POLICY), {
    appId: "PU5HXZ4FZ2.com.twitter-studio.Tweetbot",
    bundleVersions: ["1"],
    environment: "production",
    mode: "required_with_invite",
  });
  assert.deepEqual(
    config.ratelimits.map((limit) => limit.namespace_id),
    ["1101", "1102", "1103", "1104"],
  );
  const sandbox = deploymentConfig(env).config;
  const sandboxDatabase = /"database_id":\s*"([a-f0-9-]{36})"/.exec(
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  )?.[1];
  assert.ok(sandboxDatabase);
  for (const overrides of [
    { WORKER_NAME: env.WORKER_NAME },
    { D1_DATABASE_ID: sandboxDatabase },
    { PROD_DEVICE_TOKEN_KEY_CHECKS: sandbox.vars.DEVICE_TOKEN_KEY_CHECKS },
  ])
    assert.throws(() => deploymentConfig({ ...f.env, ...overrides }, f));
  assert.equal((await executeDeployment(f.env, f)).status, "production_verification_deployed");
  assert.ok(f.calls.some((url) => url.endsWith("/environments/production-verification")));
  assert.ok(f.calls.every((url) => !url.includes("/environments/sandbox")));
});
test("production検証のD1 migrationは別の保護Environmentを使う", async () => {
  const f = fixture({ productionVerification: true, migrate: true });
  assert.equal((await executeDeployment(f.env, f)).status, "migration_applied");
  assert.ok(
    f.calls.some((url) => url.endsWith("/environments/production-verification-migrations")),
  );
});
test("productionの有効化なしではsandboxの有効化があっても操作しない", async () => {
  const f = fixture({ productionVerification: true });
  await assert.rejects(
    executeDeployment(
      {
        ...f.env,
        SANDBOX_DEPLOY_ENABLED: "true",
        PRODUCTION_VERIFICATION_DEPLOY_ENABLED: "false",
      },
      f,
    ),
  );
  assert.equal(f.calls.length, 0);
});
test("production検証のD1またはQueueが一致しなければ操作しない", async () => {
  for (const path of ["/d1/database/", "/queues/"]) {
    const f = fixture({
      productionVerification: true,
      bootstrap: true,
      mutate: (url, data) => {
        if (url.pathname.includes(path)) {
          if ("name" in data) data.name = "notification-service";
          if ("queue_name" in data) data.queue_name = "notification-apns-retries";
        }
      },
    });
    await assert.rejects(executeDeployment(f.env, f));
    assert.equal(f.count(), 0);
  }
});
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
  assert.equal(
    f.calls.filter((url) => new URL(url).origin === "https://api.cloudflare.com").length,
    1,
  );
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

test("公開productionの初期配置は専用資源を使い、登録と配送を閉じる", async () => {
  const f = fixture({ publicProduction: true, bootstrap: true });
  const { config } = deploymentConfig(
    {
      ...f.env,
      PUBLIC_ENROLLMENT_ENABLED: "true",
      PUBLIC_DELIVERY_ENABLED: "true",
    },
    f,
  );
  assert.equal(config.vars.PUBLIC_ENROLLMENT_ENABLED, "false");
  assert.equal(config.vars.PUBLIC_DELIVERY_ENABLED, "false");
  assert.equal(config.d1_databases[0].database_name, "notification-service-production");
  assert.equal(config.queues.producers[0].queue, "notification-apns-production");
  assert.deepEqual(
    config.ratelimits.map((limit) => limit.namespace_id),
    ["1201", "1202", "1203", "1204"],
  );
  assert.deepEqual(JSON.parse(config.vars.APP_ATTEST_POLICY), {
    appId: "PU5HXZ4FZ2.com.twitter-studio.Tweetbot",
    bundleVersions: ["2"],
    environment: "production",
    mode: "required",
  });
  assert.equal((await executeDeployment(f.env, f)).status, "public_production_closed_deployed");
  assert.ok(f.calls.some((url) => url.endsWith("/environments/production")));
  assert.ok(f.calls.every((url) => !url.includes("prod-verification")));
});

test("公開productionでは専用Environmentが無効、または検証Workerなら変更しない", async () => {
  const f = fixture({ publicProduction: true });
  await assert.rejects(
    executeDeployment(
      {
        ...f.env,
        PUBLIC_PRODUCTION_DEPLOY_ENABLED: "false",
        PRODUCTION_VERIFICATION_DEPLOY_ENABLED: "true",
      },
      f,
    ),
  );
  assert.equal(f.calls.length, 0);
  assert.throws(() => deploymentConfig({ ...f.env, WORKER_NAME: productionEnv.WORKER_NAME }, f));
  assert.throws(() =>
    deploymentConfig(
      {
        ...f.env,
        PROD_DEVICE_TOKEN_KEY_CHECKS: JSON.stringify({
          fingerprint: "0123456789abcdef",
          keys: { production: "5555666677778888" },
        }),
      },
      f,
    ),
  );
  assert.equal(f.count(), 0);
});

test("公開productionは閉鎖したまま許可ビルドを更新し、配置後に新しい値を確認する", async () => {
  const f = fixture({
    publicProduction: true,
    mutate(url, settings) {
      if (!url.pathname.endsWith("/settings") || f.count() !== 0) return;
      const binding = settings.bindings.find(({ name }) => name === "APP_ATTEST_POLICY");
      binding.text = JSON.stringify({ ...JSON.parse(binding.text), bundleVersions: ["1"] });
    },
  });
  assert.equal((await executeDeployment(f.env, f)).status, "public_production_closed_deployed");
  assert.equal(f.count(), 1);
});

test("公開productionの許可ビルド更新はApp IDの相違や配置後の旧ビルドを拒否する", async () => {
  for (const after of [false, true]) {
    const f = fixture({
      publicProduction: true,
      mutate(url, settings) {
        if (!url.pathname.endsWith("/settings") || f.count() > 0 !== after) return;
        const binding = settings.bindings.find(({ name }) => name === "APP_ATTEST_POLICY");
        const policy = JSON.parse(binding.text);
        if (after) policy.bundleVersions = ["1"];
        else policy.appId = "PU5HXZ4FZ2.com.example.other";
        binding.text = JSON.stringify(policy);
      },
    });
    await assert.rejects(executeDeployment(f.env, f));
    assert.equal(f.count(), Number(after));
  }
});

test("公開productionの試験は保護Environmentで期限と招待ハッシュを指定する", async () => {
  const trial = {
    PUBLIC_TRIAL_UNTIL: new Date(Date.now() + 30 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    PUBLIC_TRIAL_INVITE_HASH: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA",
  };
  const f = fixture({ publicProduction: true, trial });
  assert.equal((await executeDeployment(f.env, f)).status, "public_production_trial_deployed");
  for (const overrides of [
    { PUBLIC_TRIAL_INVITE_HASH: "" },
    { PUBLIC_TRIAL_INVITE_HASH: "a".repeat(43) },
    { PUBLIC_TRIAL_UNTIL: "2020-01-01T00:00:00Z" },
    { PUBLIC_TRIAL_UNTIL: "2099-01-01T00:00:00Z" },
    {
      DEPLOY_OPERATION: "migrate",
      DEPLOY_CONFIRMATION: `migrate:${sha}`,
      BACKUP_CONFIRMED: "true",
    },
  ]) {
    await assert.rejects(executeDeployment({ ...f.env, ...overrides }, f));
    assert.equal(f.count(), 1);
  }
});

test("公開productionの試験は既存登録があれば拒否し、閉鎖配置で試験設定を取り除ける", async () => {
  const trial = {
    PUBLIC_TRIAL_UNTIL: new Date(Date.now() + 30 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    PUBLIC_TRIAL_INVITE_HASH: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA",
  };
  const populated = fixture({
    publicProduction: true,
    trial,
    mutate(url, result) {
      if (url.pathname.endsWith("/query")) result[0].results[0].has_accounts = 1;
    },
  });
  await assert.rejects(executeDeployment(populated.env, populated));
  assert.equal(populated.count(), 0);
  const closing = fixture({
    publicProduction: true,
    mutate(url, settings) {
      if (url.pathname.endsWith("/settings") && closing.count() === 0) {
        settings.bindings.push({
          name: "PUBLIC_TRIAL",
          type: "plain_text",
          text: "previous trial",
        });
      }
    },
  });
  assert.equal(
    (await executeDeployment(closing.env, closing)).status,
    "public_production_closed_deployed",
  );
});

test("公開productionの招待secret、異なるDB・Queue、滞留を配置前に拒否する", async () => {
  for (const change of [
    (url, result) => {
      if (url.pathname.endsWith("/settings"))
        result.bindings.push({ name: "ENROLLMENT_INVITE_CODE", type: "secret_text" });
    },
    (url, result) => {
      if (url.pathname.includes("/d1/database/"))
        result.name = "notification-service-prod-verification";
    },
    (url, result) => {
      if (url.pathname.includes("/workers/workers/"))
        result.subdomain.url = `https://${publicEnv.WORKER_NAME}.other.workers.dev`;
    },
    (url, result) => {
      if (url.pathname.endsWith("/metrics")) result.backlog_count = 1;
    },
    (url, result) => {
      if (url.pathname.endsWith(`/queues/${publicEnv.CF_QUEUE_ID}`))
        result.queue_name = "notification-apns-prod-verification";
    },
  ]) {
    const f = fixture({ publicProduction: true, bootstrap: true, mutate: change });
    await assert.rejects(executeDeployment(f.env, f));
    assert.equal(f.count(), 0);
  }
});

test("公開productionのQueueに別consumerがあれば初期配置しない", async () => {
  const f = fixture({
    publicProduction: true,
    bootstrap: true,
    mutate(url, result) {
      if (url.pathname.endsWith(`/queues/${publicEnv.CF_QUEUE_ID}`)) {
        result.consumers_total_count = 1;
        result.consumers = [{ type: "http_pull" }];
      }
    },
  });
  await assert.rejects(executeDeployment(f.env, f));
  assert.equal(f.count(), 0);
});
test("公開productionのmigrationには別Environmentを使い、公開Workerを更新しない", async () => {
  const f = fixture({ publicProduction: true, migrate: true });
  assert.equal((await executeDeployment(f.env, f)).status, "migration_applied");
  assert.ok(f.calls.some((url) => url.endsWith("/environments/production-migrations")));
  assert.ok(f.calls.every((url) => !url.includes("/workers/scripts/")));
});

test("Cloudflare側の403をアプリの登録停止の確認に使わない", async () => {
  const f = fixture({ publicProduction: true, bootstrap: true, edgeForbidden: true });
  await assert.rejects(executeDeployment(f.env, f));
  assert.equal(f.count(), 1);
});

test("公開productionの配置後は専用Worker以外のconsumerを成功扱いしない", async () => {
  const f = fixture({
    publicProduction: true,
    bootstrap: true,
    mutate(url, result) {
      if (url.pathname.endsWith(`/queues/${publicEnv.CF_QUEUE_ID}`) && f.count() === 1) {
        result.consumers[0].script = "other-worker";
      }
    },
  });
  await assert.rejects(executeDeployment(f.env, f));
  assert.equal(f.count(), 1);
});
