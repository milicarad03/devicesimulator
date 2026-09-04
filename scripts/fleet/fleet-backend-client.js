const DEFAULT_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_MS = 15_000;

async function sendActiveCommand(options, deviceId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await options.fetchImpl(
      `${options.backendUrl}/device/${encodeURIComponent(deviceId)}/command`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: 'SET_STATE',
          payload: { state: 'ACTIVE' },
        }),
        signal: controller.signal,
      },
    );
    const body = await response.json().catch(() => ({}));

    if (!response.ok || body.success === false) {
      throw new Error(
        body.message || body.error || `HTTP_${response.status}`,
      );
    }

    return {
      deviceId,
      success: true,
      status: body.status || 'DISPATCHED',
      correlationId: body.correlationId,
    };
  } catch (error) {
    return {
      deviceId,
      success: false,
      error:
        error?.name === 'AbortError'
          ? 'REQUEST_TIMEOUT'
          : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function activateFleet(deviceIds, options = {}) {
  const token = options.token || process.env.FLEET_ADMIN_TOKEN;
  if (!token) throw new Error('FLEET_ADMIN_TOKEN_REQUIRED');

  const settings = {
    token,
    backendUrl: (
      options.backendUrl ||
      process.env.FLEET_BACKEND_URL ||
      'http://localhost:3000'
    ).replace(/\/$/, ''),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: options.fetchImpl || fetch,
  };
  const concurrency = Math.max(
    1,
    Math.min(
      Number(options.concurrency || DEFAULT_CONCURRENCY),
      deviceIds.length || 1,
    ),
  );
  const results = new Array(deviceIds.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < deviceIds.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await sendActiveCommand(
        settings,
        deviceIds[index],
      );
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

module.exports = {
  activateFleet,
  sendActiveCommand,
};
