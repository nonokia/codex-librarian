import { runWorker } from './worker';

export function main(): void {
  console.log('taskflow api up');
  runWorker();
}

main();
