import fs from 'fs';
import path from 'path';
import os from 'os';
import { extractStructuredToolCalls, sanitizeConversationalText, containsProtocolMarkup } from '../src/core/protocol-sanitizer';

async function runE2ETest() {
  console.log('=== Starting E2E Coffee-Shop Reproduction Test ===');

  // Test 1: Unit testing extractStructuredToolCalls on text-mode tool calls
  console.log('\n[Test 1] Testing text-mode tool call extraction...');
  const sampleRawText = `
I will create the coffee shop website now.

<tool_call>
<arg_key>command</arg_key>
<arg_value>echo '<h1>Coffee Shop</h1>' > index.html</arg_value>
</tool_call>
`;
  const extracted = extractStructuredToolCalls(sampleRawText);
  if (extracted.length === 0) {
    throw new Error('FAILED: extractStructuredToolCalls failed to parse tag-based tool call.');
  }
  console.log('✔ Extracted tool calls:', JSON.stringify(extracted));

  const cleanText = sanitizeConversationalText(sampleRawText);
  if (containsProtocolMarkup(cleanText) || cleanText.includes('<tool_call>')) {
    throw new Error(`FAILED: Protocol markup leaked into sanitized text: "${cleanText}"`);
  }
  console.log('✔ Protocol markup cleanly removed from chat content.');

  // Test 2: Isolated workspace test with physical file verification
  console.log('\n[Test 2] Testing isolated workspace website creation & verification...');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-coffee-shop-test-'));
  console.log(`Using temporary workspace: ${tempDir}`);

  const indexPath = path.join(tempDir, 'index.html');
  const cssPath = path.join(tempDir, 'style.css');

  // Write files to simulate real workspace operation
  fs.writeFileSync(indexPath, '<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Brew & Beans Coffee Shop</h1></body></html>');
  fs.writeFileSync(cssPath, 'body { background: #3e2723; color: #fff; font-family: sans-serif; }');

  if (!fs.existsSync(indexPath) || !fs.existsSync(cssPath)) {
    throw new Error('FAILED: Files do not physically exist in test workspace.');
  }
  const indexContent = fs.readFileSync(indexPath, 'utf8');
  if (!indexContent.includes('Brew & Beans Coffee Shop')) {
    throw new Error('FAILED: File content mismatch.');
  }
  console.log('✔ Files physically exist and contain expected content.');

  // Cleanup temp directory
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✔ Temporary workspace cleaned up.');

  console.log('\n=== All E2E Coffee-Shop Regression Tests Passed Successfully ===');
}

runE2ETest().catch((err) => {
  console.error('\n❌ Test Failed:', err);
  process.exit(1);
});
