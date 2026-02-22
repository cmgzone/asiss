const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

const copyTasks = [
  {
    src: path.join(root, 'src', 'channels', 'web', 'public'),
    dest: path.join(root, 'dist', 'channels', 'web', 'public')
  },
  {
    src: path.join(root, 'src', 'soul.md'),
    dest: path.join(root, 'dist', 'soul.md')
  }
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyRecursive(srcPath, destPath) {
  const stats = fs.statSync(srcPath);
  if (stats.isDirectory()) {
    ensureDir(destPath);
    for (const entry of fs.readdirSync(srcPath)) {
      copyRecursive(path.join(srcPath, entry), path.join(destPath, entry));
    }
    return;
  }

  ensureDir(path.dirname(destPath));
  fs.copyFileSync(srcPath, destPath);
}

for (const task of copyTasks) {
  if (!fs.existsSync(task.src)) {
    console.warn(`[copy-runtime-assets] Skipped missing path: ${task.src}`);
    continue;
  }
  copyRecursive(task.src, task.dest);
  console.log(`[copy-runtime-assets] Copied ${task.src} -> ${task.dest}`);
}
