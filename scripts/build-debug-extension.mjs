import { spawn } from 'node:child_process';

const browser = process.argv[2];
if (!browser) {
  throw new Error('Usage: node scripts/build-debug-extension.mjs <chrome|edge>');
}

await run('pnpm', ['exec', 'wxt', 'build', '--browser', browser], {
  ...process.env,
  TABER_ENABLE_DEBUGGER: '1',
  TABER_DEBUG_ARTIFACT: '1',
});

console.log(`[OK] Debug build written to .output/${browser}-mv3-dev`);

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}
