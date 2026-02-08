import http from 'http';

async function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d) => chunks.push(Buffer.from(d)));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', reject);
    req.setTimeout(1500, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

async function main() {
  const ports = [3000, 3001, 3002, 3003];
  for (const port of ports) {
    const url = `http://localhost:${port}/`;
    try {
      const html = await fetchText(url);
      if (html.includes('id="settings-model"') && html.includes('NVIDIA')) {
        console.log(`FOUND ${port}`);
        process.exit(0);
      }
    } catch {
    }
  }
  console.log('NOT_FOUND');
  process.exit(1);
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
