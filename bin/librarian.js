#!/usr/bin/env node
// Entry shim: silence the node:sqlite ExperimentalWarning before the store
// module is loaded, then hand off to the compiled CLI.
process.on('warning', () => {});
const orig = process.emitWarning;
process.emitWarning = (warning, ...args) => {
  const name = typeof args[0] === 'string' ? args[0] : args[0]?.type;
  if (name === 'ExperimentalWarning' || warning?.name === 'ExperimentalWarning') return;
  return orig.call(process, warning, ...args);
};
await import('../dist/cli.js');
