export function createLimiter(maxConcurrent = 1) {
  const limit = Math.max(1, Number(maxConcurrent) || 1);
  let active = 0;
  const pending = [];

  return async function limitRun(fn) {
    if (active >= limit) {
      await new Promise((resolve) => pending.push(resolve));
    }
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      const next = pending.shift();
      if (next) next();
    }
  };
}
