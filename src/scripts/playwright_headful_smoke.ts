import { PlaywrightSkill } from '../skills/playwright';

async function main() {
  const skill = new PlaywrightSkill();
  const result = await skill.execute({
    action: 'screenshot',
    url: 'https://example.com',
    headless: false,
    slowMoMs: 50,
    keepOpenMs: 1500,
    persistent: false
  });
  if (result?.error) throw new Error(String(result.error));
  process.stdout.write('OK\n');
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e) + '\n');
  process.exit(1);
});

