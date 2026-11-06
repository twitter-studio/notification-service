export class DeploymentFailure extends Error {
  constructor() {
    super("deployment_rejected");
  }
}
export function publicTrial(env) {
  const { PUBLIC_TRIAL_UNTIL: deadline, PUBLIC_TRIAL_INVITE_HASH: inviteHash } = env;
  const resume = env.PUBLIC_TRIAL_RESUME === "true";
  if (!deadline && !inviteHash && !resume) return;
  const now = Date.now();
  const until = Date.parse(deadline ?? "");
  if (
    env.DEPLOY_OPERATION !== "deploy" ||
    !Number.isFinite(until) ||
    new Date(until).toISOString().replace(".000Z", "Z") !== deadline ||
    until <= now ||
    until > now + 2 * 60 * 60 * 1000 ||
    (resume ? Boolean(inviteHash) : !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(inviteHash ?? ""))
  )
    throw new DeploymentFailure();
  return resume ? { until, resume } : { until, inviteHash };
}

export function deploymentRequest(
  env,
  allowMigration = false,
  productionVerification = false,
  publicProduction = false,
) {
  if (publicProduction) publicTrial(env);
  const operation = env.DEPLOY_OPERATION;
  if (productionVerification && publicProduction) throw new DeploymentFailure();
  const enabled = publicProduction
    ? env.PUBLIC_PRODUCTION_DEPLOY_ENABLED
    : productionVerification
      ? env.PRODUCTION_VERIFICATION_DEPLOY_ENABLED
      : env.SANDBOX_DEPLOY_ENABLED;
  const target = publicProduction
    ? "production"
    : productionVerification
      ? "production-verification"
      : "sandbox";
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_RUN_ATTEMPT !== "1" ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "") ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    enabled !== "true" ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
    env.DEPLOY_SHA !== env.GITHUB_SHA ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? "") ||
    !/^[A-Za-z0-9-]{1,39}$/.test(env.DEPLOY_REVIEWER ?? "") ||
    !["deploy", ...(allowMigration ? ["migrate"] : [])].includes(operation) ||
    env.DEPLOY_CONFIRMATION !== `${operation}:${env.GITHUB_SHA}` ||
    env.MAINTENANCE_CONFIRMED !== "true" ||
    (operation === "migrate" ? env.BACKUP_CONFIRMED !== "true" : env.SCHEMA_CONFIRMED !== "true")
  )
    throw new DeploymentFailure();
  return {
    operation,
    environment: operation === "migrate" ? `${target}-migrations` : target,
    sha: env.GITHUB_SHA,
    repository: env.GITHUB_REPOSITORY,
  };
}
export async function checkDeploymentGate(
  env,
  {
    fetchImpl = fetch,
    allowMigration = false,
    requireApproval = false,
    productionVerification = false,
    publicProduction = false,
  } = {},
) {
  const request = deploymentRequest(env, allowMigration, productionVerification, publicProduction);
  if (!env.GH_TOKEN || /[\r\n]/.test(env.GH_TOKEN)) throw new DeploymentFailure();
  async function get(path) {
    const response = await fetchImpl(`https://api.github.com/repos/${request.repository}/${path}`, {
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new DeploymentFailure();
    }
    const raw = await response.text();
    if (raw.length > 262144) throw new DeploymentFailure();
    return JSON.parse(raw);
  }
  const environment = await get(`environments/${request.environment}`);
  const reviewer = environment.protection_rules?.find((rule) => rule.type === "required_reviewers");
  if (
    environment.name !== request.environment ||
    (publicProduction && environment.can_admins_bypass !== false) ||
    reviewer?.reviewers?.length !== 1 ||
    !reviewer?.reviewers?.some(
      (value) => value.type === "User" && value.reviewer?.login === env.DEPLOY_REVIEWER,
    ) ||
    environment.deployment_branch_policy?.custom_branch_policies !== true ||
    environment.deployment_branch_policy?.protected_branches !== false
  )
    throw new DeploymentFailure();
  const policies = await get(
    `environments/${request.environment}/deployment-branch-policies?per_page=100`,
  );
  if (
    policies.total_count !== 1 ||
    policies.branch_policies?.length !== 1 ||
    policies.branch_policies[0].name !== "main" ||
    policies.branch_policies[0].type !== "branch"
  )
    throw new DeploymentFailure();
  const runs = await get(
    `actions/workflows/ci.yml/runs?event=push&head_sha=${request.sha}&per_page=5`,
  );
  if (
    !runs.workflow_runs?.some(
      (run) =>
        run.head_sha === request.sha &&
        run.event === "push" &&
        run.head_branch === "main" &&
        run.status === "completed" &&
        run.conclusion === "success",
    )
  )
    throw new DeploymentFailure();
  if (requireApproval) {
    const history = await get(`actions/runs/${env.GITHUB_RUN_ID}/approvals`);
    if (
      !Array.isArray(history) ||
      !history.some(
        (entry) =>
          entry.state === "approved" &&
          entry.user?.login === env.DEPLOY_REVIEWER &&
          entry.environments?.some((value) => value.name === request.environment),
      )
    )
      throw new DeploymentFailure();
  }
  return request;
}
if (import.meta.main) {
  try {
    const productionVerification = process.argv[2] === "production-verification";
    const publicProduction = process.argv[2] === "public-production";
    await checkDeploymentGate(process.env, {
      allowMigration: publicProduction || productionVerification || process.argv[2] === "service",
      productionVerification,
      publicProduction,
    });
    console.log("deployment_gate_ok");
  } catch {
    console.error("deployment_gate_rejected");
    process.exitCode = 1;
  }
}
