import { AgentsMdSkill } from '../skills/agents-md';

async function main() {
  const skill = new AgentsMdSkill();
  const result = await skill.execute({ action: 'status', includeDaily: true });
  if (!result?.success) {
    throw new Error(`agents_md smoke failed: ${JSON.stringify(result)}`);
  }
  process.stdout.write('OK\n');
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e) + '\n');
  process.exit(1);
});

