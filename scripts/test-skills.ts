import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { database, initializeDatabase } from '../lib/db.ts';
import {
  MAX_SKILLS,
  availableSkillPathsForUrl,
  deleteSkill,
  findSkillByFileName,
  hostFromUrl,
  listSkills,
  matchSkillsForUrl,
  normalizeSkillHost,
  parseSkillFile,
  saveSkill,
  serializeSkillFile,
  setSkillEnabled,
  skillFileName,
  skillsDigestForTask,
} from '../lib/skills.ts';

await initializeDatabase();

// host normalization
assert.equal(normalizeSkillHost('Example.com'), 'example.com');
assert.equal(normalizeSkillHost('https://www.Example.com/path?q=1'), 'example.com');
assert.equal(normalizeSkillHost('www.example.com/path'), 'example.com');
assert.throws(() => normalizeSkillHost('chrome://settings'), /Invalid skill host/);
assert.throws(() => normalizeSkillHost('not a host'), /Invalid skill host/);
assert.equal(hostFromUrl('https://www.github.com/x'), 'github.com');
assert.equal(hostFromUrl('chrome://settings'), undefined);
assert.equal(hostFromUrl(undefined), undefined);

// skill file naming + frontmatter roundtrip
assert.equal(skillFileName({ name: 'GitHub PR Review' }), 'github-pr-review.md');
assert.equal(skillFileName({ name: '  淘宝 搜索!! ' }), '淘宝-搜索.md');
const serialized = serializeSkillFile({ name: 'GitHub PR review', hosts: ['github.com'], description: 'Reviewing PRs', content: '## Flow\nOpen Files changed first.' });
const parsed = parseSkillFile(serialized);
assert.deepEqual(parsed, { name: 'GitHub PR review', hosts: ['github.com'], description: 'Reviewing PRs', content: '## Flow\nOpen Files changed first.' });
assert.throws(() => parseSkillFile('no frontmatter body'), /frontmatter/);
assert.throws(() => parseSkillFile('---\nname: x\n---\nbody'), /hosts/);

// save + upsert by name (case-insensitive)
await saveSkill({ name: 'GitHub PR review', hosts: ['github.com', 'www.github.com'], description: 'Reviewing pull requests', content: 'v1', source: 'agent' });
await saveSkill({ name: 'github pr review', hosts: ['github.com'], description: 'Updated', content: 'v2', source: 'agent' });
const skills = await listSkills();
assert.equal(skills.length, 1);
assert.equal(skills[0].description, 'Updated');
assert.deepEqual(skills[0].hosts, ['github.com']);
assert.equal(await findSkillByFileName('github-pr-review.md').then((skill) => skill?.name), 'github pr review');

// matching: exact + subdomain, disabled excluded, non-http excluded
await saveSkill({ name: 'Example checkout', hosts: ['example.com'], description: 'Checkout flow', content: 'body', source: 'user' });
assert.deepEqual((await matchSkillsForUrl('https://gist.github.com/x')).map((skill) => skill.name), ['github pr review']);
assert.deepEqual((await matchSkillsForUrl('https://example.com')).map((skill) => skill.name), ['Example checkout']);
assert.deepEqual(await matchSkillsForUrl('https://notexample.com'), []);
assert.deepEqual(await matchSkillsForUrl('chrome://settings'), []);

const exampleSkill = (await listSkills()).find((skill) => skill.name === 'Example checkout')!;
await setSkillEnabled(exampleSkill.id, false);
assert.deepEqual(await matchSkillsForUrl('https://example.com'), []);
await setSkillEnabled(exampleSkill.id, true);

// digest + available paths
const digest = await skillsDigestForTask('https://github.com/pulls', 'review my PRs');
assert.match(digest, /## Site skills/);
assert.match(digest, /- \/skills\/github-pr-review\.md: Updated/);
assert.match(digest, /fs read/);
assert.match(digest, /live page state always wins/);
assert.equal(await skillsDigestForTask('https://nomatch.dev', 'hello'), '');
assert.deepEqual(await availableSkillPathsForUrl('https://example.com'), ['/skills/example-checkout.md']);

// slug collisions are rejected: /skills paths must stay unique
await saveSkill({ name: 'A B', hosts: ['example.com'], description: 'first', content: 'c', source: 'user' });
await assert.rejects(
  saveSkill({ name: 'A-B', hosts: ['example.com'], description: 'second', content: 'c', source: 'user' }),
  /Skill name conflict: "A-B" and "A B" both map to \/skills\/a-b\.md/,
);
// updating the same skill (case-insensitive) is not a collision
await saveSkill({ name: 'a b', hosts: ['example.com'], description: 'updated first', content: 'c', source: 'user' });
const slugPaths = (await listSkills()).map((skill) => skillFileName(skill));
assert.equal(new Set(slugPaths).size, slugPaths.length);
await deleteSkill((await listSkills()).find((skill) => skill.name === 'a b')!.id);

// delete
await deleteSkill(exampleSkill.id);
assert.equal((await listSkills()).length, 1);

// skill cap
await database.skills.clear();
for (let index = 0; index < MAX_SKILLS; index += 1) {
  await saveSkill({ name: `skill-${index}`, hosts: ['example.com'], description: 'd', content: 'c', source: 'agent' });
}
await assert.rejects(
  saveSkill({ name: 'overflow', hosts: ['example.com'], description: 'd', content: 'c', source: 'agent' }),
  /Skill limit reached/,
);
await saveSkill({ name: 'skill-0', hosts: ['example.com'], description: 'updated', content: 'c', source: 'agent' });

console.log('test-skills passed');

// builtin seeds are idempotent per version and never overwrite user/agent skills
{
  const { seedBuiltinSkills, builtinSkillSeeds } = await import('../lib/skills-seeds.ts');
  await database.skills.clear();
  await database.settings.delete('builtinSkillsVersion');
  await saveSkill({ name: 'GitHub REST API', hosts: ['github.com'], description: 'my custom notes', content: 'my content', source: 'agent' });
  assert.equal(await seedBuiltinSkills(), true);
  assert.equal(await seedBuiltinSkills(), false);
  const seeded = await listSkills();
  assert.equal(seeded.length, builtinSkillSeeds.length);
  const github = seeded.find((skill) => skill.name === 'GitHub REST API')!;
  assert.equal(github.source, 'agent');
  assert.equal(github.description, 'my custom notes');
  assert.equal(seeded.filter((skill) => skill.source === 'builtin').length, builtinSkillSeeds.length - 1);
  const douyin = seeded.find((skill) => skill.name === 'Douyin browsing');
  assert.match(douyin?.content ?? '', /https:\/\/www\.douyin\.com\/hot/);
  assert.match(douyin?.content ?? '', /browser snapshot/);
  assert.match(douyin?.content ?? '', /Never infer what an unlabeled card number means/);
  assert.deepEqual((await matchSkillsForUrl('https://zh.wikipedia.org/wiki/X')).map((skill) => skill.name), ['Wikipedia REST API']);
  assert.match(await skillsDigestForTask('https://news.ycombinator.com/', 'top stories'), /hacker-news-data-api\.md/);
  // A prompt mentioning the site surfaces its skill even when the current tab is elsewhere.
  assert.match(await skillsDigestForTask('https://www.google.com/search?q=x', '去tixbay 看看赵露思演唱会价格'), /tixbay-ticket-resale-api\.md/);
  assert.equal(await skillsDigestForTask('https://nomatch.dev', '随便看看新闻'), '');
}

// Every builtin seed carries a category and zh localization for the skills panel.
{
  const { builtinSkillSeeds, builtinSkillDisplay } = await import('../lib/skills-seeds.ts');
  const categories = new Set(['ticketing', 'shopping', 'social', 'video', 'travel', 'developer', 'reference']);
  for (const seed of builtinSkillSeeds) {
    assert.ok(categories.has(seed.category), `${seed.name} has invalid category ${seed.category}`);
    assert.ok(seed.nameZh.trim().length > 0, `${seed.name} missing nameZh`);
    assert.ok(seed.descriptionZh.trim().length > 0, `${seed.name} missing descriptionZh`);
  }
  assert.deepEqual(builtinSkillDisplay('tixbay ticket resale api')?.nameZh, 'Tixbay 票务转售 API');
  assert.equal(builtinSkillDisplay('unknown skill'), undefined);
  const seededCategory = (await listSkills()).find((skill) => skill.name === 'Tixbay ticket resale API');
  assert.equal(seededCategory?.category, 'ticketing');
}

// The sidepanel must finish seeding before databaseReady gates the UI open;
// otherwise a fast first click on Skills reads an empty table (false empty state).
// Combined with the behavior check above (seed resolve ⇒ listSkills returns all
// seeds), this pins the boot ordering: seeding completes before the panel opens.
{
  const { readFileSync } = await import('node:fs');
  const appSource = readFileSync(new URL('../entrypoints/sidepanel/App.svelte', import.meta.url), 'utf8');
  const seedIndex = appSource.indexOf('await seedBuiltinSkills()');
  const readyIndex = appSource.indexOf('databaseReady = true');
  assert.ok(seedIndex !== -1, 'App.svelte must await seedBuiltinSkills() during boot');
  assert.ok(readyIndex !== -1, 'App.svelte must gate the UI with databaseReady');
  assert.ok(seedIndex < readyIndex, 'App.svelte must finish seeding builtin skills before databaseReady opens the UI');
}

console.log('test-skills seeds passed');
