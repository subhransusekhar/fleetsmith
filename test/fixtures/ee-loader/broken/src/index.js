// A fixture whose register() always throws, standing in for a broken
// enterprise install. The loader must print exactly one warning and continue
// with core behavior — a bug in an optional package must not brick the CLI.
export function register() {
  throw new Error('deliberately broken fixture');
}
