#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const targets = {
  start: {
    dist: path.join(__dirname, '..', 'dist', 'index.js'),
    src: path.join(__dirname, '..', 'src', 'index.ts')
  },
  wizard: {
    dist: path.join(__dirname, '..', 'dist', 'cli', 'wizard.js'),
    src: path.join(__dirname, '..', 'src', 'cli', 'wizard.ts')
  }
};

function printHelp() {
  console.log('Usage: gitu [command]');
  console.log('');
  console.log('Commands:');
  console.log('  start   Start the assistant (default)');
  console.log('  wizard  Run setup wizard');
  console.log('  help    Show this help');
}

function resolveTarget(command) {
  const entry = targets[command];
  if (!entry) return null;
  if (fs.existsSync(entry.dist)) {
    return { file: entry.dist, useTsRuntime: false };
  }
  if (fs.existsSync(entry.src)) {
    return { file: entry.src, useTsRuntime: true };
  }
  return null;
}

function runScript(command, args) {
  const target = resolveTarget(command);
  if (!target) {
    console.error('[gitu] Runtime files are missing. Reinstall package.');
    process.exit(1);
  }

  let child;
  if (target.useTsRuntime) {
    const tsNodeBin = path.join(
      __dirname,
      '..',
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'ts-node.cmd' : 'ts-node'
    );
    if (!fs.existsSync(tsNodeBin)) {
      console.error('[gitu] ts-node runtime is missing. Reinstall package.');
      process.exit(1);
    }
    child = spawn(tsNodeBin, ['--transpile-only', target.file, ...args], {
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32'
    });
  } else {
    child = spawn(process.execPath, [target.file, ...args], {
      stdio: 'inherit',
      env: process.env
    });
  }

  child.on('error', (error) => {
    console.error(`[gitu] Failed to launch: ${error.message}`);
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(typeof code === 'number' ? code : 0);
  });
}

const command = process.argv[2];
const args = process.argv.slice(3);

if (!command) {
  runScript('start', []);
} else if (command === 'start') {
  runScript('start', args);
} else if (command === 'wizard') {
  runScript('wizard', args);
} else if (command === 'help' || command === '--help' || command === '-h') {
  printHelp();
} else {
  console.error(`[gitu] Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}
