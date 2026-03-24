export interface HealthcheckResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export async function checkHealth(
  port: number,
  healthcheckPath: string,
): Promise<HealthcheckResult> {
  const url = `http://127.0.0.1:${port}${healthcheckPath}`;

  try {
    const response = await fetch(url);
    return {
      ok: response.ok,
      status: response.status,
      ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "unknown request error",
    };
  }
}

export async function waitForHealth(
  port: number,
  healthcheckPath: string,
  timeoutMs = 30_000,
): Promise<HealthcheckResult> {
  const deadline = Date.now() + timeoutMs;
  let lastResult: HealthcheckResult = {
    ok: false,
    error: "healthcheck not attempted",
  };

  while (Date.now() < deadline) {
    lastResult = await checkHealth(port, healthcheckPath);
    if (lastResult.ok) {
      return lastResult;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  return lastResult;
}
