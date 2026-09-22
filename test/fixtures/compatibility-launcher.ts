import { ensureCoordinator } from "../../src/coordination/owner-launcher";
try {
  const result = await ensureCoordinator({ configPath: process.argv[2]!, nodePath: process.execPath,
    ownerPath: process.argv[3]!, timeoutMs: 2000 });
  console.log(JSON.stringify(await result.client.request({ op: "compatibility" })));
  result.client.close();
} catch (error) {
  console.error(JSON.stringify({ code: (error as any).code, message: (error as Error).message }));
  process.exitCode = 1;
}
