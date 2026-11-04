import { readFile } from "node:fs/promises";
import { evaluateMonitoring } from "../src/monitoring.ts";

try {
  if (process.argv.length !== 3) throw new Error();
  const result = evaluateMonitoring(JSON.parse(await readFile(process.argv[2], "utf8")));
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "invalid" ? 1 : result.status === "alert" ? 2 : 0;
} catch {
  // パス、入力、パーサーの例外には秘密が入りうるため、診断も固定する。
  console.error(JSON.stringify({ status: "invalid" }));
  process.exitCode = 1;
}
