import OpenAI from 'openai';

async function main() {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error('NVIDIA_API_KEY is missing in environment (.env).');
  }

  const client = new OpenAI({
    baseURL: 'https://integrate.api.nvidia.com/v1',
    apiKey
  });

  const res: any = await client.models.list();
  const ids: string[] = Array.isArray(res?.data) ? res.data.map((m: any) => m.id).filter(Boolean) : [];
  process.stdout.write(JSON.stringify({ count: ids.length, models: ids }, null, 2) + '\n');
}

main().catch((e: any) => {
  const status = typeof e?.status === 'number' ? e.status : undefined;
  const msg = e?.message || String(e);
  process.stderr.write(JSON.stringify({ error: msg, status }, null, 2) + '\n');
  process.exit(1);
});

