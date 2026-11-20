export function runnerHeaders(): Record<string, string> {
  return process.env.RUNNER_TOKEN ? { 'x-runner-key': process.env.RUNNER_TOKEN } : {};
}

export function runnerBaseUrl(): string {
  return (process.env.RUNNER_BASE_URL || 'http://localhost:3111').replace(/\/$/, '');
}
