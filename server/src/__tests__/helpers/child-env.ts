/**
 * Environment for a child process that a test starts.
 *
 * A developer machine or CI wrapper can set Node flags that make every child
 * print to stderr before it runs any test code. The common one is
 * `NODE_EXTRA_CA_CERTS` pointing at a file the test user cannot read: Node then
 * prints `Warning: Ignoring extra certs from …` on startup. A test that asserts
 * a child's stderr is empty fails on the machine rather than on the behaviour.
 *
 * Drop the harness-only overrides. The children in these tests talk to loopback
 * HTTP servers, so no TLS trust is lost.
 */
export function childProcessEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_EXTRA_CA_CERTS;
  delete env.NODE_OPTIONS;
  return { ...env, ...overrides };
}
