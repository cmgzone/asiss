import fs from 'fs';
import { PlaywrightSkill } from '../skills/playwright';

async function main() {
  const skill = new PlaywrightSkill();
  const res = await skill.execute({ action: 'screenshot', url: 'https://example.com', fullPage: true, timeoutMs: 20000 });
  if (!res?.filePath || !fs.existsSync(res.filePath)) {
    throw new Error('Screenshot not created: ' + JSON.stringify(res));
  }
  process.stdout.write('OK\n');
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e) + '\n');
  process.exit(1);
});

