import assert from 'assert';
import { WorkspaceManager } from '../src/core/workspace-manager';
import path from 'path';

async function main() {
  const ws = new WorkspaceManager();
  const root = process.cwd();

  // Test listTree
  const tree = await ws.listTree(root, 2);
  assert.ok(Array.isArray(tree), 'listTree returns an array');
  assert.ok(tree.length > 0, 'listTree returned items');
  assert.ok(tree.some(n => n.name === 'package.json' && !n.isDir), 'package.json is listed as a file');
  assert.ok(tree.some(n => n.name === 'src' && n.isDir), 'src is listed as a directory');
  assert.ok(!tree.some(n => n.name === 'node_modules'), 'node_modules is excluded');
  assert.ok(!tree.some(n => n.name === '.git'), '.git is excluded');
  console.log('1. listTree hierarchical filtering: ok');

  // Test readFileContent
  const pkgFile = await ws.readFileContent(root, 'package.json');
  assert.ok(pkgFile && pkgFile.content.includes('gitu'), 'readFileContent reads package.json');
  console.log('2. readFileContent within bounds: ok');

  // Test path traversal security
  let traversalBlocked = false;
  try {
    await ws.readFileContent(root, '../../../../etc/passwd');
  } catch (err: any) {
    traversalBlocked = true;
  }
  assert.ok(traversalBlocked, 'Path traversal outside workspace root is blocked');
  console.log('3. path traversal security guard: ok');

  console.log('workspace-api verification: 3/3 gates passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
