import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { experimental_readRawConfig } from "wrangler";
import { z } from "zod";
import {
  checkDeploymentGate,
  DeploymentFailure,
  publicDeploymentMode,
  publicTrial,
} from "./deployment-gate.mjs";

const KIND = "service";
const verificationWorker = "notification-service-prod-verification";
const verificationQueue = "notification-apns-prod-verification";
const publicWorker = "notification-service-production";
const publicQueue = "notification-apns-production";
const publicBootstrap = "PUBLIC_PRODUCTION_BOOTSTRAP";
const publicSwitches = ["PUBLIC_ENROLLMENT_ENABLED", "PUBLIC_DELIVERY_ENABLED"];
const directory = resolve(import.meta.dirname, "..");
const name = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const Inputs = z.object({
  CLOUDFLARE_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/),
  CF_WORKER_SUBDOMAIN: name,
  CF_QUEUE_ID: z.string().regex(/^[a-f0-9]{32}$/),
  WORKER_NAME: name,
  ...(KIND === "service"
    ? { D1_DATABASE_ID: z.uuid() }
    : {
        X_USER_ID: z.string().regex(/^[1-9][0-9]{0,18}$/),
        RELAY_URL: z.url().refine((value) => {
          const u = new URL(value);
          return (
            u.protocol === "https:" &&
            !u.username &&
            !u.password &&
            !u.port &&
            !u.search &&
            !u.hash &&
            u.pathname === "/"
          );
        }),
      }),
});
export function deploymentConfig(
  env,
  { productionVerification = false, publicProduction = false } = {},
) {
  if (productionVerification && publicProduction) throw new DeploymentFailure();
  const expectedWorker = publicProduction
    ? publicWorker
    : productionVerification
      ? verificationWorker
      : "notification-service";
  const input = Inputs.parse(env);
  const configPath = resolve(
    directory,
    KIND === "service" ? "wrangler.jsonc" : "wrangler.example.jsonc",
  );
  const parsed = experimental_readRawConfig({ config: configPath });
  if (parsed.configPath !== configPath || parsed.redirected) throw new DeploymentFailure();
  const config = structuredClone(parsed.rawConfig);
  if (KIND === "service" && input.WORKER_NAME !== expectedWorker) throw new DeploymentFailure();
  config.name = input.WORKER_NAME;
  config.account_id = input.CLOUDFLARE_ACCOUNT_ID;
  config.main = resolve(directory, "src/index.ts");
  config.send_metrics = false;
  config.preview_urls = false;
  config.workers_dev = true;
  if (KIND === "worker") {
    config.vars = {
      ...config.vars,
      ENABLE_X_ACTIVITY: "false",
      ENABLE_MOCK_EVENTS: "false",
      X_USER_ID: input.X_USER_ID,
      RELAY_URL: input.RELAY_URL,
    };
  } else {
    if (productionVerification || publicProduction) {
      const database = config.d1_databases[0];
      if (input.D1_DATABASE_ID.toLowerCase() === database.database_id)
        throw new DeploymentFailure();
      database.database_name = expectedWorker;
      const queueName = publicProduction ? publicQueue : verificationQueue;
      config.queues.producers[0].queue = queueName;
      config.queues.consumers[0].queue = queueName;
      config.limits = { cpu_ms: 1000 };
      for (const limit of config.ratelimits)
        limit.namespace_id = String(Number(limit.namespace_id) + (publicProduction ? 200 : 100));
      const keyId = publicProduction ? "production" : "prod-verification";
      const keyChecks = z
        .strictObject({
          fingerprint: z.string().regex(/^[a-f0-9]{16}$/),
          keys: z.strictObject({ [keyId]: z.string().regex(/^[a-f0-9]{16}$/) }),
        })
        .parse(JSON.parse(env.PROD_DEVICE_TOKEN_KEY_CHECKS));
      const sandboxChecks = JSON.parse(config.vars.DEVICE_TOKEN_KEY_CHECKS);
      const otherChecks = [sandboxChecks.fingerprint, ...Object.values(sandboxChecks.keys)];
      if (publicProduction) {
        const verificationChecks = z
          .strictObject({
            fingerprint: z.string().regex(/^[a-f0-9]{16}$/),
            keys: z.strictObject({ "prod-verification": z.string().regex(/^[a-f0-9]{16}$/) }),
          })
          .parse(JSON.parse(env.VERIFICATION_DEVICE_TOKEN_KEY_CHECKS));
        otherChecks.push(verificationChecks.fingerprint, ...Object.values(verificationChecks.keys));
      }
      const checks = [keyChecks.fingerprint, keyChecks.keys[keyId]];
      if (
        new Set(checks).size !== checks.length ||
        checks.some((value) => otherChecks.includes(value))
      )
        throw new DeploymentFailure();
      config.vars.DEVICE_TOKEN_KEY_CHECKS = JSON.stringify(keyChecks);
      config.vars.APP_ATTEST_POLICY = JSON.stringify({
        mode: publicProduction ? "required" : "required_with_invite",
        environment: "production",
        appId: "PU5HXZ4FZ2.com.twitter-studio.Tweetbot",
      });
      if (publicProduction) {
        const enabled = String(publicDeploymentMode(env) === "open");
        for (const key of publicSwitches) config.vars[key] = enabled;
        const trial = publicTrial(env);
        if (trial) config.vars.PUBLIC_TRIAL = JSON.stringify(trial);
      }
    }
    config.d1_databases[0].database_id = input.D1_DATABASE_ID;
    config.d1_databases[0].migrations_dir = resolve(directory, "../../packages/db/migrations");
    const policy = JSON.parse(config.vars.APP_ATTEST_POLICY);
    if (
      !productionVerification &&
      !publicProduction &&
      (policy.mode !== "invite_only" || policy.environment !== "development")
    )
      throw new DeploymentFailure();
  }
  return {
    config,
    input,
    origin: `https://${input.WORKER_NAME}.${input.CF_WORKER_SUBDOMAIN}.workers.dev`,
  };
}
const ExpectedSecrets =
  KIND === "worker"
    ? ["RELAY_TOKEN", "X_EVENT_ID_SECRET", "X_OAUTH2_CLIENT_SECRET"]
    : [
        "APNS_PROVIDER_KEYS",
        "CHALLENGE_SIGNING_KEY",
        "DEVICE_TOKEN_FINGERPRINT_KEY",
        "DEVICE_TOKEN_KEYS",
        "ENROLLMENT_INVITE_CODE",
      ];
function expectedSecrets(publicProduction) {
  return publicProduction
    ? ExpectedSecrets.filter((name) => name !== "ENROLLMENT_INVITE_CODE")
    : ExpectedSecrets;
}
function checkSecrets(bindings, publicProduction) {
  const expected = expectedSecrets(publicProduction);
  if (
    expected.some(
      (name) =>
        !bindings.some((binding) => binding.name === name && binding.type === "secret_text"),
    ) ||
    (publicProduction &&
      bindings.some(
        (binding) =>
          binding.name === "ENROLLMENT_INVITE_CODE" ||
          (binding.type === "secret_text" && !expected.includes(binding.name)),
      ))
  )
    throw new DeploymentFailure();
}
export function checkSnapshot(
  snapshot,
  config,
  {
    before = false,
    publicProduction = false,
    publicPreflight = false,
    attestPreflight = before || publicPreflight,
  } = {},
) {
  const bindings = z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
        text: z.string().optional(),
        id: z.string().optional(),
        queue_name: z.string().optional(),
      }),
    )
    .parse(snapshot.bindings);
  if (
    publicProduction &&
    bindings.some(
      (binding) =>
        binding.type === "plain_text" &&
        !Object.hasOwn(config.vars, binding.name) &&
        !(
          publicPreflight &&
          config.vars.PUBLIC_ENROLLMENT_ENABLED === "false" &&
          binding.name === "PUBLIC_TRIAL"
        ),
    )
  )
    throw new DeploymentFailure();
  for (const [key, value] of Object.entries(config.vars)) {
    const current = bindings.find(
      (binding) => binding.name === key && binding.type === "plain_text",
    );
    if (publicPreflight && key === "PUBLIC_TRIAL") {
      if (bindings.some((binding) => binding.name === key)) throw new DeploymentFailure();
      continue;
    }
    if (!current) throw new DeploymentFailure();
    if (before && key === "DEVICE_TOKEN_KEY_CHECKS") {
      const schema = z.strictObject({
        fingerprint: z.string().regex(/^[a-f0-9]{16}$/),
        keys: z.record(
          z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
          z.string().regex(/^[a-f0-9]{16}$/),
        ),
      });
      const oldChecks = schema.parse(JSON.parse(current.text));
      const newChecks = schema.parse(JSON.parse(value));
      if (
        oldChecks.fingerprint !== newChecks.fingerprint ||
        !Object.entries(oldChecks.keys).every(([id, kcv]) => newChecks.keys[id] === kcv)
      )
        throw new DeploymentFailure();
    } else if (attestPreflight && key === "APP_ATTEST_POLICY") {
      const policy = z
        .strictObject({
          mode: z.enum(["invite_only", "required", "required_with_invite"]),
          environment: z.enum(["development", "production"]),
          appId: z.string().regex(/^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/),
        })
        .parse(JSON.parse(value));
      z.strictObject({
        mode: z.literal(policy.mode),
        environment: z.literal(policy.environment),
        appId: z.literal(policy.appId),
        bundleVersions: z.array(z.string().min(1).max(128)).min(1).max(100).optional(),
      }).parse(JSON.parse(current.text));
    } else if (publicProduction && publicPreflight && publicSwitches.includes(key)) {
      z.enum(["true", "false"]).parse(current.text);
      if (config.vars.PUBLIC_TRIAL && current.text !== "false") throw new DeploymentFailure();
    } else if (current.text !== value) throw new DeploymentFailure();
  }
  if (
    !bindings.some(
      (binding) =>
        binding.type === "queue" &&
        binding.name === config.queues.producers[0].binding &&
        binding.queue_name === config.queues.producers[0].queue,
    )
  )
    throw new DeploymentFailure();
  checkSecrets(bindings, publicProduction);
  if (
    KIND === "service" &&
    !bindings.some(
      (binding) =>
        binding.type === "d1" &&
        binding.name === "DB" &&
        binding.id === config.d1_databases[0].database_id,
    )
  )
    throw new DeploymentFailure();
}
function singleActiveVersion(deployments) {
  const active = deployments.deployments?.[0]?.versions;
  if (
    active?.length !== 1 ||
    active[0].percentage !== 100 ||
    !z.uuid().safeParse(active[0].version_id).success
  )
    throw new DeploymentFailure();
  return active[0].version_id;
}
function checkPublicQueue(details, config, id, bootstrap) {
  const count = bootstrap ? 0 : 1;
  const { producers = [], consumers = [] } = details;
  if (
    details.queue_id !== id ||
    details.queue_name !== publicQueue ||
    details.producers_total_count !== count ||
    details.consumers_total_count !== count ||
    producers.length !== count ||
    consumers.length !== count ||
    !producers.every((value) => value.type === "worker" && value.script === config.name) ||
    !consumers.every(
      (value) =>
        value.type === "worker" &&
        (value.script ?? value.script_name) === config.name &&
        (value.script_name === undefined || value.script_name === config.name),
    )
  )
    throw new DeploymentFailure();
}
export async function executeDeployment(
  env,
  {
    fetchImpl = fetch,
    runCommand = (command, args, options) => spawnSync(command, args, options),
    productionVerification = false,
    publicProduction = false,
  } = {},
) {
  const request = await checkDeploymentGate(env, {
    fetchImpl,
    allowMigration: KIND === "service",
    requireApproval: true,
    productionVerification,
    publicProduction,
  });
  const { config, input, origin } = deploymentConfig(env, {
    productionVerification,
    publicProduction,
  });
  const publicMode = publicProduction ? publicDeploymentMode(env) : "closed";
  if (!env.CLOUDFLARE_API_TOKEN || /[\r\n]/.test(env.CLOUDFLARE_API_TOKEN))
    throw new DeploymentFailure();
  const source = runCommand("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" });
  const dirty = runCommand("git", ["status", "--porcelain"], { cwd: directory, encoding: "utf8" });
  if (
    source.status !== 0 ||
    source.stdout.trim() !== request.sha ||
    dirty.status !== 0 ||
    dirty.stdout.trim()
  )
    throw new DeploymentFailure();
  let calls = 0;
  async function response(url, options = {}) {
    if (++calls > 16) throw new DeploymentFailure();
    const result = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    return result;
  }
  async function api(path, { sql, params, token = env.CLOUDFLARE_API_TOKEN } = {}) {
    const result = await response(
      `https://api.cloudflare.com/client/v4/accounts/${input.CLOUDFLARE_ACCOUNT_ID}/${path}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(sql === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(sql === undefined ? {} : { method: "POST", body: JSON.stringify({ sql, params }) }),
      },
    );
    if (result.status !== 200) {
      await result.body?.cancel();
      throw new DeploymentFailure();
    }
    const raw = await result.text();
    if (raw.length > 262144) throw new DeploymentFailure();
    const root = JSON.parse(raw);
    if (root.success !== true) throw new DeploymentFailure();
    return root.result;
  }
  const worker = `workers/scripts/${config.name}`;
  const queue = `queues/${input.CF_QUEUE_ID}`;
  if (publicProduction || productionVerification || request.operation === "migrate") {
    const db = await api(`d1/database/${input.D1_DATABASE_ID}`);
    if (db.uuid !== input.D1_DATABASE_ID || db.name !== config.d1_databases[0].database_name)
      throw new DeploymentFailure();
  }
  const migration = request.operation === "migrate";
  const stateToken = publicProduction && migration ? env.PUBLIC_WORKER_READ_TOKEN : undefined;
  if (
    publicProduction &&
    migration &&
    (!stateToken || /[\r\n]/.test(stateToken) || stateToken === env.CLOUDFLARE_API_TOKEN)
  )
    throw new DeploymentFailure();
  const stateApi = (path) => api(path, { token: stateToken });
  async function versionSettings(version) {
    const details = await stateApi(`${worker}/versions/${version}`);
    if (details.id !== version || !details.resources) throw new DeploymentFailure();
    return details.resources;
  }
  if (!migration || publicProduction) {
    if (publicProduction) {
      const workerRecord = await stateApi(`workers/workers/${config.name}`);
      if (workerRecord?.name !== config.name || workerRecord.subdomain?.url !== origin)
        throw new DeploymentFailure();
    }
    const settings =
      publicProduction && (migration || publicMode === "open")
        ? await versionSettings(singleActiveVersion(await stateApi(`${worker}/deployments`)))
        : await stateApi(`${worker}/settings`);
    const bootstrap =
      (productionVerification || publicProduction) &&
      settings.bindings?.some(
        (binding) =>
          binding.name ===
            (publicProduction ? publicBootstrap : "PRODUCTION_VERIFICATION_BOOTSTRAP") &&
          binding.type === "plain_text" &&
          binding.text === "true",
      );
    if (bootstrap) {
      if (config.vars.PUBLIC_TRIAL || publicMode !== "closed") throw new DeploymentFailure();
      if (settings.bindings.length !== expectedSecrets(publicProduction).length + 1)
        throw new DeploymentFailure();
      checkSecrets(settings.bindings, publicProduction);
    } else {
      if (
        migration &&
        (settings.bindings.some((binding) => binding.name === "PUBLIC_TRIAL") ||
          !publicSwitches.every((key) =>
            settings.bindings.some(
              (binding) =>
                binding.name === key && binding.type === "plain_text" && binding.text === "false",
            ),
          ))
      )
        throw new DeploymentFailure();
      checkSnapshot(settings, config, {
        before: !productionVerification && !publicProduction,
        publicProduction,
        publicPreflight: publicProduction,
        attestPreflight: true,
      });
    }
    const details = await stateApi(queue);
    if (publicProduction) checkPublicQueue(details, config, input.CF_QUEUE_ID, bootstrap);
    if (details.queue_name !== config.queues.producers[0].queue) throw new DeploymentFailure();
    if (publicMode !== "stop") {
      const metrics = await stateApi(`${queue}/metrics`);
      if (metrics.backlog_count !== 0 || metrics.backlog_bytes !== 0) throw new DeploymentFailure();
    }
    const trial = publicProduction ? publicTrial(env) : undefined;
    if (trial) {
      const resume = trial.resume === true;
      const sql = resume
        ? `SELECT (SELECT COUNT(*) FROM notification_accounts) AS accounts,
            EXISTS(SELECT 1 FROM notification_accounts a
              JOIN installations i ON i.account_id = a.id
              JOIN installation_attestations t ON t.installation_id = i.id
              JOIN devices d ON d.installation_id = i.id
              WHERE a.state = 'active' AND i.revoked_at IS NULL AND t.environment = 'production'
                AND d.state = 'active' AND d.apns_environment = 'production'
                ${trial.relayId ? "AND d.verified_at IS NOT NULL AND EXISTS(SELECT 1 FROM relay_credentials r WHERE r.account_id = a.id AND r.id = ?1 AND r.revoked_at IS NULL AND (r.expires_at IS NULL OR r.expires_at >= ?2))" : ""}) AS trial_device`
        : "SELECT EXISTS(SELECT 1 FROM notification_accounts) AS has_accounts";
      const result = await api(`d1/database/${input.D1_DATABASE_ID}/query`, {
        sql,
        params: trial.relayId ? [trial.relayId, String(trial.until)] : undefined,
      });
      const row = resume
        ? z.object({ accounts: z.literal(1), trial_device: z.literal(1) })
        : z.object({ has_accounts: z.literal(0) });
      z.tuple([z.object({ success: z.literal(true), results: z.tuple([row]) })]).parse(result);
    }
  }
  const path = resolve(directory, `.sandbox-deploy-${randomUUID()}.jsonc`);
  if (publicProduction) publicTrial(env);
  try {
    writeFileSync(path, JSON.stringify(config), { mode: 0o600, flag: "wx" });
    const args =
      request.operation === "migrate"
        ? [
            "exec",
            "wrangler",
            "d1",
            "migrations",
            "apply",
            config.d1_databases[0].database_name,
            "--remote",
            "--config",
            path,
          ]
        : ["exec", "wrangler", "deploy", "--config", path];
    // WranglerはvarsやAPIエラー本文を表示するため、ログへそのまま転送しない。
    const runtimeEnv = { ...env, CI: "true", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" };
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "CLOUDFLARE_API_KEY",
      "CLOUDFLARE_EMAIL",
      "PUBLIC_WORKER_READ_TOKEN",
    ])
      delete runtimeEnv[key];
    const result = runCommand("pnpm", args, {
      cwd: directory,
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 1024 * 1024,
      env: runtimeEnv,
    });
    if (result.status !== 0) throw new DeploymentFailure();
    if (request.operation === "migrate") return { status: "migration_applied", sha: request.sha };
    const version = result.stdout.match(
      /Current Version ID:\s*([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})/i,
    )?.[1];
    if (!version) throw new DeploymentFailure();
    checkSnapshot(await api(`${worker}/settings`), config, { publicProduction });
    const deployments = await api(`${worker}/deployments`);
    if (singleActiveVersion(deployments) !== version) throw new DeploymentFailure();
    if (publicProduction)
      checkSnapshot(await versionSettings(version), config, { publicProduction });
    if (publicProduction) checkPublicQueue(await api(queue), config, input.CF_QUEUE_ID, false);
    if (publicMode !== "stop" && publicMode !== "open") {
      const metrics = await api(`${queue}/metrics`);
      if (metrics.backlog_count !== 0 || metrics.backlog_bytes !== 0) throw new DeploymentFailure();
    }
    const schedules = await api(`${worker}/schedules`);
    if (
      !config.triggers.crons.every((cron) =>
        schedules.schedules?.some((value) => value.cron === cron),
      )
    )
      throw new DeploymentFailure();
    const checks =
      KIND === "worker"
        ? [
            ["/health", "GET", 200],
            ["/webhooks/x", "GET", 404],
            ["/webhooks/x", "POST", 404],
            ["/webhooks/mock", "POST", 404],
          ]
        : [["/health", "GET", 200]];
    if (publicProduction)
      checks.push([
        "/v1/enrollments",
        "POST",
        publicMode === "open" ? 401 : 403,
        { challenge: "", public_key: "", signature: "" },
      ]);
    for (const [path, method, status, body] of checks) {
      const result = await response(origin + path, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      });
      if (result.status !== status) {
        await result.body?.cancel();
        throw new DeploymentFailure();
      }
      if (body === undefined) {
        await result.body?.cancel();
      } else {
        const type = result.headers.get("Content-Type")?.split(";")[0]?.trim();
        if (type !== "application/problem+json") {
          await result.body?.cancel();
          throw new DeploymentFailure();
        }
        const raw = await result.text();
        if (raw.length > 4096) throw new DeploymentFailure();
        const problem = JSON.parse(raw);
        if (
          problem.status !== status ||
          problem.detail !==
            (publicMode === "open"
              ? "The challenge is invalid."
              : "Enrollment is not available.") ||
          !z.uuid().safeParse(problem.request_id).success ||
          problem.request_id !== result.headers.get("X-Request-Id")
        )
          throw new DeploymentFailure();
      }
    }
    return {
      status: publicProduction
        ? config.vars.PUBLIC_TRIAL
          ? "public_production_trial_deployed"
          : `public_production_${publicMode}_deployed`
        : productionVerification
          ? "production_verification_deployed"
          : "sandbox_deployed",
      sha: request.sha,
      version,
    };
  } finally {
    unlinkSync(path);
  }
}
if (import.meta.main) {
  try {
    console.log(
      JSON.stringify(
        await executeDeployment(process.env, {
          productionVerification: process.argv[2] === "production-verification",
          publicProduction: process.argv[2] === "public-production",
        }),
      ),
    );
  } catch {
    console.error("sandbox_operation_failed_manual_verification_required");
    process.exitCode = 1;
  }
}
