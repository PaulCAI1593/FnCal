import fs from 'node:fs';
const V0 = '0.7.12', V1 = '0.7.13';
const plan = [['README.md', 9], ['DOCKER.md', 12], ['Dockerfile', 4], ['docker-compose.yml', 2]];
let total = 0;
for (const [f, want] of plan) {
  const s = fs.readFileSync(f, 'utf8');
  const hits = s.split(V0).length - 1;
  console.log(f, 'hits', hits);
  if (hits !== want) { console.error('FAIL', f, hits, want); process.exit(1); }
  fs.writeFileSync(f, s.split(V0).join(V1), 'utf8');
  total += hits;
}
for (const f of ['code/app/server.mjs', 'code/fnos/manifest']) {
  const s = fs.readFileSync(f, 'utf8');
  console.log(f, 'has', V1, s.includes(V1));
  if (!s.includes(V1)) process.exit(1);
}
console.log('replaced', total);