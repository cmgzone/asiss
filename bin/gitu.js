#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const targets = {
  start: path.join(__dirname, '..', 'dist', 'index.js'),
  wizard: path.join(__dirname, '..', 'dist', 'cli', 'wizard.js')
};

function printHelp() {
  console.log('Usage: gitu [command]');
  console.log('');
  console.log('Commands:');
  console.log('  start   Start the assistant (default)');
  console.log('  wizard  Run setup wizard');
  console.log('  help    Show this help');
}

function runScript(target, args) {
  if (!fs.existsSync(target)) {
    console.error('[gitu] Build artifacts are missing. Reinstall or run `npm run build`.');
    process.exit(1);
  }

  const child = spawn(process.execPath, [target, ...args], {
    stdio: 'inherit',
    env: process.env
  });

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
  runScript(targets.start, []);
} else if (command === 'start') {
  runScript(targets.start, args);
} else if (command === 'wizard') {
  runScript(targets.wizard, args);
} else if (command === 'help' || command === '--help' || command === '-h') {
  printHelp();
} else {
  console.error(`[gitu] Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}
