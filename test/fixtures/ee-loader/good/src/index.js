// A minimal fixture standing in for `fleetsmith-ee`, loaded via
// FLEETSMITH_EE_PATH by the CLI loader tests in test/fleetsmith.test.js.
// Registers one CLI command so the dispatcher-fallback path is exercised
// end-to-end, without depending on the real ee/ package.
export function register(registry) {
  registry.registerCliCommand('grid-fixture', async (argv) => {
    console.log(`grid-fixture ran with: ${argv.join(' ')}`);
    return 0;
  });
}
